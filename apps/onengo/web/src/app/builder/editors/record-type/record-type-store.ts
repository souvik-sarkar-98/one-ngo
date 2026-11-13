import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { Usage } from '../../../core/builder/http-builder';
import { httpEditor } from '../../../core/builder/http-editor';
import {
  addField,
  addLookup,
  addRule,
  allows,
  duplicateField,
  fieldOf,
  numberPreview,
  removeField,
  removeLookup,
  removeRule,
  renameKey,
  setLabel,
  setLookup,
  setRule,
  shownFields,
  uniqueKey,
  usesSummary,
  type FieldDef,
  type RecordTypeDef,
} from '../../../core/builder/ops/record-type';
import { t } from '../../../core/i18n/i18n';
import { listSource, type SuggestionSource } from '../../../core/ui-logic/autocomplete';
import { Api } from '../../../services/api';
import { BuilderStore } from '../../builder-store';

export type RecordTypePage = 'fields' | 'rules' | 'lookups' | 'usedBy' | 'workflows';

/**
 * The record type editor's state over the Builder's draft: the open page and
 * field, the keys fixed by publishing, the next number, what uses the type
 * and its fields, and the fields of linked record types. Every change goes
 * through the pure operations in core/builder/ops/record-type.
 */
@Injectable()
export class RecordTypeStore {
  private readonly builder = inject(BuilderStore);
  private readonly editor = httpEditor(inject(Api));
  private readonly loading = new Set<string>();
  private readonly gateway = this.builder.gateway;

  readonly expressions = this.builder.expressions;
  readonly body = computed(() => this.builder.body() as unknown as RecordTypeDef | null);
  readonly key = computed(() => this.body()?.key ?? '');
  readonly allows = computed(() => allows({ key: this.key() }));
  readonly page = computed<RecordTypePage>(() => {
    const tab = this.builder.address().tab;
    return tab === 'rules' || tab === 'lookups' || tab === 'usedBy' || (tab === 'workflows' && this.allows().workflows) ? tab : 'fields';
  });
  readonly fields = computed(() => (this.body() ? shownFields(this.body()!) : []));
  /**
   * A field whose key just changed (its key follows its label): the address
   * still names the old key until the navigation lands, and the panel must
   * not close and reopen in between.
   */
  private readonly renamed = signal<{ from: string; to: string } | null>(null);
  readonly selected = computed(() => {
    const key = this.builder.address().field;
    const b = this.body();
    if (!key || !b) return null;
    const r = this.renamed();
    return fieldOf(b, key) ?? (r && r.from === key ? fieldOf(b, r.to) : null) ?? null;
  });
  readonly selectedRule = signal<string | null>(null);
  readonly selectedLookup = signal<string | null>(null);
  /** Keys of the organisation's http connectors, once loaded; empty when they cannot be read here. */
  readonly httpConnectors = signal<string[]>([]);
  /** Field keys of the published version: they cannot change any more. */
  readonly fixedKeys = computed(() => {
    const fields = this.builder.state()?.detail?.published?.body['fields'];
    return new Set(Array.isArray(fields) ? (fields as FieldDef[]).map((f) => f.key) : []);
  });
  readonly notice = signal('');

  readonly recordTypes = signal<{ key: string; label: string }[]>([]);
  readonly recordTypeSource: SuggestionSource = {
    minLength: 0,
    search: (q) => listSource(this.recordTypes().map((r) => ({ id: r.key, label: r.label, hint: r.key }))).search(q),
  };
  readonly permissionSource: SuggestionSource = {
    minLength: 0,
    search: async (q) => (await this.editor.permissionSuggestions(q)).map((s) => ({ id: s.permission, label: s.permission, hint: s.label })),
  };
  /** Published fields of other record types, by key, once asked for. */
  readonly linked = signal<Record<string, FieldDef[]>>({});

  private readonly next = signal<{ next: number; fy: string } | null>(null);
  readonly nextNumber = computed(() => {
    const n = this.body()?.numbering;
    const next = this.next();
    return n && next !== null ? numberPreview(n, next.next, next.fy) : '';
  });
  readonly usages = signal<Usage[] | null>(null);
  readonly fieldUsages = signal<{ field: string; usages: Usage[] | null }>({ field: '', usages: null });

  constructor() {
    this.gateway
      .catalogue()
      .then((items) => this.recordTypes.set(items.filter((i) => i.kind === 'recordType').map((i) => ({ key: i.key, label: i.label || i.key }))))
      .catch(() => undefined);
    effect(() => {
      const n = this.body()?.numbering;
      const sequence = n?.sequence;
      const reset = n?.reset ?? 'fiscal_year';
      untracked(() => {
        this.next.set(null);
        if (sequence) void this.loadNext(sequence, reset);
      });
    });
    effect(() => {
      const page = this.page();
      const key = this.key();
      untracked(() => {
        if (page === 'usedBy' && key) void this.loadUsages(key);
        if (page === 'lookups' && !this.connectorsLoaded) void this.loadConnectors();
      });
    });
    effect(() => {
      const field = this.selected()?.key ?? '';
      const fixed = this.fixedKeys().has(field);
      untracked(() => {
        this.notice.set('');
        this.fieldUsages.set({ field, usages: fixed ? null : [] });
        if (fixed) void this.loadFieldUsages(field);
      });
    });
  }

  private async loadNext(sequence: string, reset: 'fiscal_year' | 'never'): Promise<void> {
    try {
      const n = await this.gateway.nextNumber(sequence, reset);
      if (this.body()?.numbering?.sequence === sequence) this.next.set({ next: n.next, fy: n.fy });
    } catch {
      this.next.set(null);
    }
  }

  private async loadUsages(key: string): Promise<void> {
    this.usages.set(null);
    try {
      this.usages.set(await this.gateway.usages('recordType', key));
    } catch {
      this.usages.set([]);
    }
  }

  private connectorsLoaded = false;

  private async loadConnectors(): Promise<void> {
    this.connectorsLoaded = true;
    try {
      this.httpConnectors.set((await this.editor.connectors()).filter((c) => c.kind === 'http').map((c) => c.key));
    } catch {
      this.httpConnectors.set([]);
    }
  }

  private async loadFieldUsages(field: string): Promise<Usage[]> {
    try {
      const usages = await this.gateway.usages('recordType', this.key(), field);
      if (this.selected()?.key === field) this.fieldUsages.set({ field, usages });
      return usages;
    } catch {
      if (this.selected()?.key === field) this.fieldUsages.set({ field, usages: [] });
      return [];
    }
  }

  /** The published fields of another record type; empty until loaded. */
  fieldsOf(recordType: string | undefined): FieldDef[] {
    if (!recordType) return [];
    if (recordType === this.key()) return this.body()?.fields ?? [];
    const known = this.linked()[recordType];
    if (!known && !this.loading.has(recordType)) {
      this.loading.add(recordType);
      this.gateway
        .publishedRecordType(recordType)
        .then((d) => this.linked.update((l) => ({ ...l, [recordType]: d.body.fields as FieldDef[] })))
        .catch(() => this.linked.update((l) => ({ ...l, [recordType]: [] })))
        .finally(() => this.loading.delete(recordType));
    }
    return known ?? [];
  }

  edit(change: (b: RecordTypeDef) => RecordTypeDef): void {
    const b = this.body();
    if (b) this.builder.edit(change(b) as unknown as Record<string, unknown>);
  }

  openPage(page: RecordTypePage): void {
    this.builder.selectTab(page === 'fields' ? 'visual' : page);
  }

  /** Choosing the field already open does nothing: only the close button (null) closes the panel. */
  select(field: string | null): void {
    if (field && field === this.builder.address().field) return;
    this.renamed.set(null);
    this.builder.select(field ? { field } : {});
  }

  private follow(from: string, to: string): void {
    this.renamed.set({ from, to });
    this.builder.select({ field: to }, true);
  }

  open(u: Usage): void {
    this.builder.openDefinition(u.kind, u.key);
  }

  addField(): void {
    const b = this.body();
    if (!b) return;
    const { body, key } = addField(b, t('ui.builder.recordType.newField'));
    this.builder.edit(body as unknown as Record<string, unknown>);
    this.select(key);
  }

  duplicate(key: string): void {
    const b = this.body();
    const f = b && fieldOf(b, key);
    if (!b || !f) return;
    const copy = duplicateField(b, key, t('ui.builder.recordType.copyOf', { label: f.label }));
    this.builder.edit(copy.body as unknown as Record<string, unknown>);
    this.select(copy.key);
  }

  /** Removes a field unless published definitions still use it; then says which. */
  async remove(key: string): Promise<void> {
    const b = this.body();
    const f = b && fieldOf(b, key);
    if (!f) return;
    const usages = this.fixedKeys().has(key) ? await this.loadFieldUsages(key) : [];
    if (usages.length) {
      this.notice.set(t('ui.builder.recordType.stillUsed', { label: f.label, uses: usesSummary(usages) }));
      return;
    }
    if (!confirm(t('ui.builder.recordType.confirmRemove', { label: f.label }))) return;
    this.edit((x) => removeField(x, key));
    if (this.selected()?.key === key) this.select(null);
  }

  /** A field always keeps a name: clearing the box while retyping changes nothing until there is text. */
  setLabel(key: string, label: string): void {
    const b = this.body();
    if (!b || !label.trim()) return;
    const next = setLabel(b, key, label, this.fixedKeys().has(key));
    this.builder.edit(next.body as unknown as Record<string, unknown>);
    if (next.key !== key) this.follow(key, next.key);
  }

  setKey(key: string, text: string): void {
    const b = this.body();
    if (!b || this.fixedKeys().has(key)) return;
    const typed = text.trim().replace(/[^A-Za-z0-9_]/g, '');
    const next = uniqueKey(b, typed ? typed[0]!.toLowerCase() + typed.slice(1) : key, key);
    this.edit((x) => renameKey(x, key, next));
    if (next !== key) this.follow(key, next);
  }

  addRule(): void {
    const b = this.body();
    if (!b) return;
    const { body, key } = addRule(b);
    this.builder.edit(body as unknown as Record<string, unknown>);
    this.selectedRule.set(key);
  }

  renameRule(key: string, text: string): void {
    const b = this.body();
    const next = text.trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (!b || !next || next === key || b.rules?.some((r) => r.key === next)) return;
    this.edit((x) => setRule(x, key, { key: next }));
    this.selectedRule.set(next);
  }

  removeRule(key: string): void {
    this.edit((b) => removeRule(b, key));
    if (this.selectedRule() === key) this.selectedRule.set(null);
  }

  addLookup(): void {
    const b = this.body();
    if (!b) return;
    const { body, key } = addLookup(b);
    this.builder.edit(body as unknown as Record<string, unknown>);
    this.selectedLookup.set(key);
  }

  renameLookup(key: string, text: string): void {
    const b = this.body();
    const next = text.trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (!b || !next || next === key || b.lookups?.some((l) => l.key === next)) return;
    this.edit((x) => setLookup(x, key, { key: next }));
    this.selectedLookup.set(next);
  }

  removeLookup(key: string): void {
    this.edit((b) => removeLookup(b, key));
    if (this.selectedLookup() === key) this.selectedLookup.set(null);
  }
}
