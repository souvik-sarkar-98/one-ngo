import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { httpEditor } from '../../../core/builder/http-editor';
import {
  addEntry,
  addItem,
  defaultValue,
  describe,
  formSections,
  moveItem,
  removeItem,
  renameEntry,
  setIn,
  switchVariant,
  type FormNode,
  type JsonSchema,
  type MapNode,
  type Path,
  type TableNode,
  type VariantNode,
} from '../../../core/builder/schema-form';
import { LOCALES } from '../../../core/i18n/i18n';
import { DEFINITION_KINDS, type CatalogueItem, type DefinitionKind } from '../../../core/models';
import { listSource, type Suggestion, type SuggestionSource } from '../../../core/ui-logic/autocomplete';
import { Api } from '../../../services/api';
import { I18n } from '../../../services/i18n';
import { BuilderStore } from '../../builder-store';

type Body = Record<string, unknown>;

const lazy = <T>(load: () => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => (p ??= load().catch((e: unknown) => ((p = null), Promise.reject(e))));
};

/**
 * The visual editor generated from a kind's JSON schema: loads the schema,
 * turns the draft body into form nodes, applies each edit to the draft through
 * the BuilderStore, and supplies the suggestions for named things.
 */
@Injectable()
export class GenericEditorStore {
  private readonly builder = inject(BuilderStore);
  private readonly i18n = inject(I18n);
  private readonly editor = httpEditor(inject(Api));
  private readonly sources = new Map<string, SuggestionSource>();
  private readonly catalogue = lazy(() => this.builder.gateway.catalogue());
  private readonly roles = lazy(() => this.editor.roles());
  private readonly connectors = lazy(() => this.editor.connectors());

  readonly schema = signal<JsonSchema | null>(null);
  readonly failed = signal(false);
  /** The selected row of each table, by the table's node id. */
  readonly selected = signal<Record<string, number | null>>({});
  readonly kind = computed(() => this.builder.state()?.kind ?? null);
  readonly draft = this.builder.body;
  readonly root = computed(() => {
    this.i18n.locale();
    const schema = this.schema();
    const body = this.builder.body();
    return schema && body ? describe(schema, body) : null;
  });
  readonly sections = computed(() => {
    const root = this.root();
    return root ? formSections(root) : [];
  });
  readonly preview = computed(() => this.schema()?.['x-preview'] ?? null);
  /** The plain message or the email HTML, whichever was focused last. Placeholder chips insert there. */
  readonly messageFocus = signal<Path>(['body']);
  readonly permissionSource: SuggestionSource = {
    minLength: 0,
    search: async (q) =>
      (await this.editor.permissionSuggestions(q)).map((s) => ({ id: s.permission, label: s.permission, hint: s.label })),
  };

  constructor() {
    effect(() => {
      const kind = this.kind();
      untracked(() => {
        if (kind) void this.load(kind);
      });
    });
  }

  private async load(kind: DefinitionKind): Promise<void> {
    this.schema.set(null);
    this.failed.set(false);
    try {
      const schema = await this.editor.schema(kind);
      if (this.kind() === kind) this.schema.set(schema);
    } catch {
      if (this.kind() === kind) this.failed.set(true);
    }
  }

  private body(): Body | null {
    return this.builder.body();
  }

  private apply(fn: (body: Body, root: JsonSchema) => Body): void {
    const body = this.body();
    const schema = this.schema();
    if (body && schema) this.builder.edit(fn(body, schema));
  }

  set(path: Path, value: unknown): void {
    this.apply((b) => setIn(b, path, value));
  }

  focusMessage(path: Path): void {
    const name = path.at(-1);
    if (name === 'body' || name === 'html') this.messageFocus.set(path);
  }

  /** Adds an optional object, such as numbering or a form, with its required settings. */
  addPart(n: FormNode): void {
    this.apply((b, root) => setIn(b, n.path, defaultValue(n.schema, root)));
  }

  addItem(table: TableNode): void {
    const count = Array.isArray(table.value) ? table.value.length : 0;
    this.apply((b, root) => addItem(b, table, root));
    this.select(table, count);
  }

  removeItem(table: TableNode, index: number): void {
    this.apply((b) => removeItem(b, table, index));
    this.select(table, null);
  }

  moveItem(table: TableNode, from: number, to: number): void {
    this.apply((b) => moveItem(b, table, from, to));
    if (this.selected()[table.id] === from) this.select(table, to);
  }

  select(table: TableNode, index: number | null): void {
    this.selected.update((s) => ({ ...s, [table.id]: index }));
  }

  switchVariant(n: VariantNode, index: number): void {
    this.apply((b, root) => switchVariant(b, n, index, root));
  }

  addEntry(map: MapNode): void {
    this.apply((b) => addEntry(b, map));
  }

  renameEntry(map: MapNode, from: string, to: string): void {
    this.apply((b) => renameEntry(b, map, from, to));
  }

  /** Suggestions for an `x-ref`: definitions of a kind, fields of the record type, roles, connectors, or languages. */
  source(ref: string): SuggestionSource {
    const recordType = ref === 'field' ? this.recordTypeKey() : '';
    const id = `${ref}:${recordType}`;
    let source = this.sources.get(id);
    if (!source) {
      source = this.makeSource(ref, recordType);
      this.sources.set(id, source);
    }
    return source;
  }

  private recordTypeKey(): string {
    const body = this.body();
    const key = this.kind() === 'recordType' ? body?.['key'] : body?.['recordType'];
    return typeof key === 'string' ? key : '';
  }

  private makeSource(ref: string, recordType: string): SuggestionSource {
    const from = (load: () => Promise<Suggestion[]>): SuggestionSource => ({
      minLength: 0,
      search: async (text) => listSource(await load()).search(text),
    });
    if ((DEFINITION_KINDS as readonly string[]).includes(ref)) {
      return from(async () =>
        (await this.catalogue())
          .filter((i: CatalogueItem) => i.kind === ref)
          .map((i) => ({ id: i.key, label: i.label || i.key, hint: i.key })),
      );
    }
    if (ref === 'field') {
      return from(async () => {
        const own = this.kind() === 'recordType' ? this.body()?.['fields'] : null;
        const fields = Array.isArray(own) ? own : recordType ? (await this.builder.gateway.publishedRecordType(recordType)).body.fields : [];
        return (fields as { key: string; label?: string }[]).map((f) => ({ id: f.key, label: f.label || f.key, hint: f.key }));
      });
    }
    if (ref === 'role') return from(async () => (await this.roles()).map((r) => ({ id: r.key, label: r.label || r.key, hint: r.key })));
    if (ref === 'connector') return from(async () => (await this.connectors()).map((c) => ({ id: c.key, label: c.key, hint: c.kind })));
    if (ref === 'locale') return listSource(LOCALES.filter((l) => l !== 'en').map((l) => ({ id: l, label: l })));
    return listSource([]);
  }
}
