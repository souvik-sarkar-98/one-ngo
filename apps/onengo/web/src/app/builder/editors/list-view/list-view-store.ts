import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { httpEditor, type IndexWarnings } from '../../../core/builder/http-editor';
import { listPreview, sampleRecords, type PreviewType } from '../../../core/builder/list-preview';
import { chipRows, fieldLabel, sectionRows } from '../../../core/builder/list-view-view';
import * as ops from '../../../core/builder/ops/list-view';
import { t } from '../../../core/i18n/i18n';
import type { ListViewDef, RecordView, RuntimeRecordType, RuntimeWorkflow } from '../../../core/models';
import type { DetailSection } from '../../../core/records/record/present';
import { httpGateway } from '../../../core/records/gateway/http-gateway';
import type { RowView } from '../../../core/rows';
import type { SuggestionSource } from '../../../core/ui-logic/autocomplete';
import { Api } from '../../../services/api';
import { I18n } from '../../../services/i18n';
import { Session } from '../../../services/session';
import type { LivePreviewView } from '../../../ui/live-preview';
import { BuilderStore } from '../../builder-store';

const NO_WARNINGS: IndexWarnings = { pending: [], notIndexed: [] };
const REAL_LIMIT = 20;

/**
 * The list view on the Visual tab: applies every change to the draft through
 * the pure operations in `core/builder/ops/list-view`, keeps the open section
 * and the create form in the address (`?section=`, `?create`), and feeds the
 * live preview from real records the administrator can read (sample records
 * otherwise) with the draft applied in memory.
 */
@Injectable()
export class ListViewEditorStore {
  private readonly builder = inject(BuilderStore);
  private readonly session = inject(Session);
  private readonly i18n = inject(I18n);
  private readonly api = inject(Api);
  private readonly records = httpGateway(this.api);
  private readonly editor = httpEditor(this.api);

  readonly body = computed(() => this.builder.body() as unknown as ListViewDef | null);
  readonly recordTypeKey = computed(() => this.body()?.recordType ?? '');
  /** The published record type; the runtime one when the person can read it. */
  readonly type = signal<RuntimeRecordType | null>(null);
  readonly types = computed(() => this.session.defs()?.recordTypes ?? []);
  readonly workflows = computed<RuntimeWorkflow[]>(() => {
    const defs = this.session.defs();
    const key = this.recordTypeKey();
    return defs?.workflowSets?.[key] ?? (defs?.workflows[key] ? [defs.workflows[key]!] : []);
  });
  readonly realRecords = signal<RecordView[] | null>(null);
  readonly sample = computed(() => !this.realRecords()?.length);
  readonly warnings = signal<IndexWarnings>(NO_WARNINGS);

  readonly selectedChip = signal<string | null>(null);
  readonly selectedSection = computed(() => this.builder.address().section ?? null);
  readonly createOpen = computed(() => this.builder.address().create);
  readonly previewView = signal<LivePreviewView>('phone');
  readonly previewChip = signal('');
  readonly previewRow = signal<string | null>(null);
  readonly previewRows = signal<RowView[]>([]);
  readonly previewRecord = signal<DetailSection[]>([]);

  /** Chip ids in the published version: shared addresses and pins name them, so they stay. */
  readonly fixedChips = computed(() => {
    const d = this.builder.state()?.detail;
    const published = (d?.published?.body ?? d?.shipped?.base) as ListViewDef | undefined;
    return (published?.chips ?? []).map((c) => c.id);
  });
  readonly chipIndex = computed(() => this.body()?.chips?.findIndex((c) => c.id === this.selectedChip()) ?? -1);
  readonly sectionIndex = computed(() => (this.body()?.detail?.sections ?? []).findIndex((s, i) => ops.sectionId(s, i) === this.selectedSection()));
  readonly chipRows = computed(() => (this.i18n.locale(), this.body() ? chipRows(this.body()!, this.workflows(), this.type() ?? undefined) : []));
  readonly sectionRows = computed(() => (this.i18n.locale(), this.body() && this.type() ? sectionRows(this.body()!, this.type()!, this.types()) : []));
  readonly missingRequired = computed(() => (this.body() && this.type() ? ops.missingRequired(this.body()!, this.type()!) : []));
  readonly indexNotices = computed(() => {
    this.i18n.locale();
    const b = this.body();
    const type = this.type();
    if (!b || !type) return [];
    return ops.indexNotices(b, this.warnings()).map((n) =>
      t(n.kind === 'pending' ? 'ui.builder.listView.indexPending' : 'ui.builder.listView.indexCap', { field: fieldLabel(type, n.field) }),
    );
  });

  readonly preview = computed(() => {
    this.i18n.locale();
    const draft = this.body();
    const type = this.type();
    if (!draft || !type) return null;
    const workflows = this.workflows();
    const defs = this.session.defs();
    const others: PreviewType[] = this.types()
      .filter((x) => x.key !== type.key)
      .map((x) => ({ type: x, workflows: defs?.workflowSets?.[x.key] ?? (defs?.workflows[x.key] ? [defs.workflows[x.key]!] : []), view: defs?.listViews?.[x.key] }));
    const records = this.realRecords()?.length ? this.realRecords()! : sampleRecords(type, workflows[0]);
    return listPreview({ draft, subject: { type, workflows }, others, records });
  });
  readonly previewSteps = computed(() => this.preview()?.create() ?? []);

  readonly permissionSource: SuggestionSource = {
    minLength: 0,
    search: async (q) => (await this.editor.permissionSuggestions(q)).map((s) => ({ id: s.permission, label: s.permission, hint: s.label })),
  };

  constructor() {
    effect(() => {
      const key = this.recordTypeKey();
      untracked(() => void this.loadType(key));
    });
    let rowsAsked = 0;
    effect(() => {
      const p = this.preview();
      const chip = this.previewChip();
      const ask = ++rowsAsked;
      untracked(() => {
        if (!p) return this.previewRows.set([]);
        void p.rows(chip).then(({ rows }) => {
          if (ask !== rowsAsked) return;
          this.previewRows.set(rows);
          if (!rows.some((r) => r.id === this.previewRow())) this.previewRow.set(rows[0]?.id ?? null);
        });
      });
    });
    let panelAsked = 0;
    effect(() => {
      const p = this.preview();
      const id = this.previewRow();
      const ask = ++panelAsked;
      untracked(() => {
        if (!p || !id) return this.previewRecord.set([]);
        void p.panel(id, this.sample() ? undefined : this.records).then((sections) => {
          if (ask === panelAsked) this.previewRecord.set(sections);
        });
      });
    });
  }

  private async loadType(key: string): Promise<void> {
    this.type.set(null);
    this.realRecords.set(null);
    this.warnings.set(NO_WARNINGS);
    if (!key) return;
    const runtime = this.session.defs()?.recordTypes.find((x) => x.key === key);
    const type = runtime ?? (await this.builder.gateway.publishedRecordType(key).then((d) => ({ ...d.body, version: 0, canCreate: false, canUpdate: false }) as RuntimeRecordType).catch(() => null));
    if (this.recordTypeKey() !== key) return;
    this.type.set(type);
    if (!type) return;
    const [records, warnings] = await Promise.all([
      runtime ? this.records.query(key, { limit: REAL_LIMIT }).then((r) => r.items).catch(() => []) : Promise.resolve([]),
      this.editor.indexWarnings(key).catch(() => NO_WARNINGS),
    ]);
    if (this.recordTypeKey() !== key) return;
    this.realRecords.set(records);
    this.warnings.set(warnings);
  }

  private apply(fn: (b: ListViewDef) => ListViewDef): void {
    const b = this.body();
    if (b) this.builder.edit(fn(b) as unknown as Record<string, unknown>);
  }

  edit(fn: (b: ListViewDef) => ListViewDef): void {
    this.apply(fn);
  }

  setRecordType(recordType: string): void {
    this.apply((b) => ({ ...b, recordType }));
  }

  // ---------------------------------------------------------------- chips

  selectChip(id: string | null): void {
    this.selectedChip.set(id);
    if (id) this.previewChip.set(id);
  }

  addChip(): void {
    this.apply((b) => ops.addChip(b, t('ui.builder.listView.newChip')));
    this.selectChip(this.body()?.chips?.at(-1)?.id ?? null);
  }

  setChipLabel(index: number, label: string): void {
    this.apply((b) => ops.setChipLabel(b, index, label, this.fixedChips()));
    this.selectedChip.set(this.body()?.chips?.[index]?.id ?? null);
  }

  removeChip(id: string): void {
    const index = this.body()?.chips?.findIndex((c) => c.id === id) ?? -1;
    if (index < 0) return;
    this.apply((b) => ops.removeChip(b, index));
    if (this.selectedChip() === id) this.selectedChip.set(null);
  }

  // ---------------------------------------------------------------- sections and create form

  selectSection(id: string | null): void {
    this.builder.select(id ? { section: id } : {});
  }

  addSection(): void {
    this.apply((b) => ops.addSection(b, 'fields', t('ui.builder.listView.newSection')));
    const sections = this.body()?.detail?.sections ?? [];
    const last = sections.at(-1);
    if (last) this.selectSection(ops.sectionId(last, sections.length - 1));
  }

  removeSection(id: string): void {
    const index = (this.body()?.detail?.sections ?? []).findIndex((s, i) => ops.sectionId(s, i) === id);
    if (index < 0) return;
    this.apply((b) => ops.removeSection(b, index));
    if (this.selectedSection() === id) this.selectSection(null);
  }

  openCreate(open: boolean): void {
    this.builder.select(open ? { create: true } : {});
  }

  /** "New donation for this donor" is offered when the related list view fills the reference from the address. */
  relatedOffer(recordType: string, field: string): { offered: boolean; list: string; field: string } | null {
    const other = this.types().find((x) => x.key === recordType);
    if (!other || !field) return null;
    const view = this.session.defs()?.listViews?.[recordType];
    return {
      offered: !!view?.create?.presets?.some((p) => p.field === field),
      list: view?.label ?? other.pluralLabel ?? other.label,
      field: fieldLabel(other, field),
    };
  }
}
