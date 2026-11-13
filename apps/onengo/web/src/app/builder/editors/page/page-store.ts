import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { httpEditor } from '../../../core/builder/http-editor';
import * as ops from '../../../core/builder/ops/page';
import { httpPages } from '../../../core/http/http-pages';
import type { FieldType, PageDef, RuntimeDefinitions, WidgetView } from '../../../core/models';
import { compactNumber, emptyContent, listSpecFor, loadWidget, planWidget, type PagesGateway, type PlannedWidget, type WidgetContent } from '../../../core/pages';
import type { RecordsGateway } from '../../../core/records/gateway/gateway';
import { httpGateway } from '../../../core/records/gateway/http-gateway';
import type { SuggestionSource } from '../../../core/ui-logic/autocomplete';
import { Api } from '../../../services/api';
import { I18n } from '../../../services/i18n';
import { Session } from '../../../services/session';
import { BuilderStore } from '../../builder-store';

export type PreviewSource = 'real' | 'sample';

interface Figures {
  defs: RuntimeDefinitions | null;
  pages: Pick<PagesGateway, 'aggregate'>;
  records: Pick<RecordsGateway, 'query'>;
}

interface Loaded {
  sig: string;
  loading: boolean;
  error: boolean;
  content: WidgetContent | null;
}

const signature = (source: PreviewSource, w: PlannedWidget) =>
  w.kind === 'list' ? JSON.stringify([source, w.spec.type.key, w.query]) : w.kind === 'stat' || w.kind === 'chart' ? JSON.stringify([source, w.recordType, w.request]) : '';

/**
 * One page on the Visual tab: applies every change to the draft through the
 * pure operations in `core/builder/ops/page`, keeps the selected widget in
 * the address (`?widget=`), and draws the live preview with the
 * administrator's own figures or the sample data of the memory gateway.
 */
@Injectable()
export class PageEditorStore {
  private readonly builder = inject(BuilderStore);
  private readonly session = inject(Session);
  private readonly i18n = inject(I18n);
  private readonly editor = httpEditor(inject(Api));
  private readonly real: Figures = { defs: null, pages: httpPages(inject(Api)), records: httpGateway(inject(Api)) };
  private readonly sample = signal<Figures | null>(null);
  private readonly loaded = signal<Record<string, Loaded>>({});

  readonly body = computed(() => this.builder.body() as unknown as PageDef | null);
  readonly selectedIndex = computed(() => {
    const raw = this.builder.address().widget;
    const i = raw === undefined ? -1 : Number(raw);
    return Number.isInteger(i) && i >= 0 && i < (this.body()?.widgets.length ?? 0) ? i : -1;
  });
  readonly selected = computed(() => this.body()?.widgets[this.selectedIndex()] ?? null);
  readonly roles = signal<{ key: string; label: string }[]>([]);
  readonly source = signal<PreviewSource>('real');
  readonly format = compactNumber;

  private readonly defs = computed(() => this.session.defs());
  readonly recordTypes = computed(() => (this.defs()?.recordTypes ?? []).map((t) => ({ key: t.key, label: t.label || t.key })));
  readonly listViews = computed(() => Object.values(this.defs()?.listViews ?? {}).map((v) => ({ key: v.key, label: v.label || v.key })));
  private readonly names = computed<ops.WidgetNames>(() => {
    const defs = this.defs();
    const type = (k: string) => defs?.recordTypes.find((t) => t.key === k);
    return {
      recordType: (k) => type(k)?.label,
      field: (rt, k) => type(rt)?.fields.find((f) => f.key === k)?.label,
      listView: (k) => Object.values(defs?.listViews ?? {}).find((v) => v.key === k)?.label,
      chip: (rt, c) => listSpecFor(defs, rt)?.chips.find((x) => x.id === c)?.label,
    };
  });
  readonly rows = computed(() => {
    this.i18n.locale();
    const b = this.body();
    return b ? ops.widgetRows(b, this.names()) : [];
  });

  readonly permissionSource: SuggestionSource = {
    minLength: 0,
    search: async (q) => (await this.editor.permissionSuggestions(q)).map((s) => ({ id: s.permission, label: s.permission, hint: s.label })),
  };

  private readonly figures = computed<Figures | null>(() => (this.source() === 'sample' ? this.sample() : { ...this.real, defs: this.defs() }));
  private readonly planned = computed(() => {
    const b = this.body();
    const f = this.figures();
    if (!b || !f) return [];
    return b.widgets.map((w, i) => ({ index: i, plan: planWidget(f.defs, b.key, { ...w, index: undefined }, i) }));
  });
  /** The preview, widget by widget; a widget that does not name what it shows yet has no model. */
  readonly preview = computed(() => {
    this.i18n.locale();
    const f = this.figures();
    const loaded = this.loaded();
    return this.planned().map(({ index, plan }) => {
      const state = plan ? loaded[`w${index}`] : undefined;
      const fresh = state && state.sig === (plan ? signature(this.source(), plan) : '');
      const content = fresh && state.content && plan && 'label' in plan && 'label' in state.content ? { ...state.content, label: plan.label } : fresh ? state.content : null;
      return {
        index,
        model: plan ? (content ?? emptyContent(plan, f?.defs ?? null)) : null,
        loading: !!plan && (!!state?.loading || (!fresh && !!signature(this.source(), plan))),
        error: !!fresh && !!state?.error,
        full: plan?.kind === 'groups',
      };
    });
  });

  constructor() {
    this.editor
      .roles()
      .then((r) => this.roles.set(r))
      .catch(() => undefined);
    effect(() => {
      const planned = this.planned();
      const source = this.source();
      untracked(() => {
        for (const { index, plan } of planned) {
          const sig = plan ? signature(source, plan) : '';
          if (plan && sig && this.loaded()[`w${index}`]?.sig !== sig) void this.load(index, plan, sig);
        }
      });
    });
  }

  fields(recordType: string, types?: readonly FieldType[]): { key: string; label: string }[] {
    const t = this.defs()?.recordTypes.find((x) => x.key === recordType);
    return (t?.fields ?? []).filter((f) => !types || types.includes(f.type)).map((f) => ({ key: f.key, label: f.label || f.key }));
  }

  chips(recordType: string): { id: string; label: string }[] {
    return (listSpecFor(this.defs(), recordType)?.chips ?? []).map((c) => ({ id: c.id, label: c.label }));
  }

  /** The chips of the record type a list view shows. */
  listChips(listView: string): { id: string; label: string }[] {
    const type = Object.values(this.defs()?.listViews ?? {}).find((v) => v.key === listView)?.recordType;
    return type ? this.chips(type) : [];
  }

  async useSource(source: PreviewSource): Promise<void> {
    if (source === 'sample' && !this.sample()) {
      const { memoryGateway } = await import('../../../core/testing/memory-gateway');
      const mg = memoryGateway();
      this.sample.set({ defs: await mg.auth.definitions(), pages: mg.pages, records: mg.records });
    }
    this.source.set(source);
  }

  retry(index: number): void {
    const plan = this.planned()[index]?.plan;
    if (plan) void this.load(index, plan, signature(this.source(), plan));
  }

  private async load(index: number, plan: PlannedWidget, sig: string): Promise<void> {
    const f = this.figures();
    if (!f) return;
    const id = `w${index}`;
    const set = (state: Loaded) => this.loaded.update((all) => (all[id] && all[id]!.sig !== sig && !state.loading ? all : { ...all, [id]: state }));
    set({ sig, loading: true, error: false, content: null });
    try {
      set({ sig, loading: false, error: false, content: await loadWidget(plan, f, f.defs) });
    } catch {
      set({ sig, loading: false, error: true, content: null });
    }
  }

  private apply(fn: (b: PageDef) => PageDef): void {
    const b = this.body();
    if (b) this.builder.edit(fn(b) as unknown as Record<string, unknown>);
  }

  // ---------------------------------------------------------------- page

  setLabel(label: string): void {
    this.apply((b) => ops.setLabel(b, label));
  }

  toggleAudience(role: string, on: boolean): void {
    this.apply((b) => ops.toggleAudience(b, role, on));
  }

  // ---------------------------------------------------------------- widgets

  select(index: number | null): void {
    this.builder.select(index === null ? {} : { widget: String(index) });
  }

  add(type: ops.WidgetType): void {
    this.apply((b) => ops.addWidget(b, type));
    this.select((this.body()?.widgets.length ?? 1) - 1);
  }

  remove(index: number): void {
    this.apply((b) => ops.removeWidget(b, index));
    const at = this.selectedIndex();
    if (at === index) this.select(null);
    else if (at > index) this.builder.select({ widget: String(at - 1) }, true);
  }

  move(from: number, to: number): void {
    const at = this.selectedIndex();
    this.apply((b) => ops.moveWidget(b, from, to));
    if (at === from) this.builder.select({ widget: String(to) }, true);
    else if (at >= 0) {
      const shifted = from < at && to >= at ? at - 1 : from > at && to <= at ? at + 1 : at;
      if (shifted !== at) this.builder.select({ widget: String(shifted) }, true);
    }
  }

  changeType(index: number, type: ops.WidgetType): void {
    this.apply((b) => ops.changeWidgetType(b, index, type));
  }

  set(index: number, patch: Record<string, unknown>): void {
    this.apply((b) => ops.setWidget(b, index, patch));
  }

  setView(index: number, patch: Partial<WidgetView>): void {
    this.apply((b) => ops.setWidgetView(b, index, patch));
  }

  setGroupBy(index: number, groupBy: ops.GroupBy): void {
    this.apply((b) => ops.setGroupBy(b, index, groupBy));
  }

  setPermission(index: number, permission: string): void {
    this.apply((b) => ops.setWidgetPermission(b, index, permission));
  }

  addLink(index: number): void {
    this.apply((b) => ops.addLink(b, index));
  }

  setLink(index: number, item: number, patch: Partial<ops.PageLinkItem>): void {
    this.apply((b) => ops.setLink(b, index, item, patch));
  }

  removeLink(index: number, item: number): void {
    this.apply((b) => ops.removeLink(b, index, item));
  }

  moveLink(index: number, from: number, to: number): void {
    this.apply((b) => ops.moveLink(b, index, from, to));
  }
}
