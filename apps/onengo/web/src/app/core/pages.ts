import { formatMoney, formatNumber, t } from './i18n/i18n';
import type { FieldFilter, PageDef, PageWidget, RecordQueryBody, RuntimeDefinitions, RuntimeRecordType, WidgetView } from './models';
import type { RecordsGateway } from './records/gateway/gateway';
import { criteriaToFilters, mergeFieldFilters, queryBody } from './records/list/query';
import { filterPills } from './records/record/present';
import { plainRecordRow } from './records/list/rows';
import { resolveListSpec, type FilterSpec, type ListSpec } from './records/spec';
import { parseListUrl, toQueryParams, type Criteria, type ListState } from './records/list/url';
import type { RowView } from './rows';
import { homeGroups, type GroupCard } from './groups';
import type { Bucket } from './ui-logic/chart';

/** The page whose widgets make up Home. */
export const HOME_PAGE = 'home';
/** Rows a pin shows on Home. */
export const PIN_ROWS = 3;
/** Rows of a list pinned for everyone. */
const SHARED_PIN_ROWS = 5;
const MAX_PIN_LABEL = 80;

/** A list someone pinned to their own Home: where it is, and what they called it. */
export interface Pin {
  id: string;
  label: string;
  listView: string;
  address: string;
  position: number;
}

export interface PinInput {
  label: string;
  listView: string;
  address: string;
}

/** What a stat or chart widget asks the server to count or add up. `widget` names the page widget asking. */
export interface AggregateRequest {
  statusIn?: string[];
  owner?: 'me';
  sharedWithMe?: true;
  filters?: Record<string, FieldFilter>;
  measure: 'count' | 'sum';
  field?: string;
  groupBy?: Extract<PageWidget, { type: 'chart' }>['groupBy'];
  widget?: { page: string; index: number };
}

export type AggregateResult = { value: number } | { buckets: Bucket[] };

/** What pages and pins need from the server. The HTTP implementation is in http-pages.ts. */
export interface PagesGateway {
  aggregate(type: string, body: AggregateRequest): Promise<AggregateResult>;
  pins(): Promise<Pin[]>;
  addPin(input: PinInput): Promise<Pin>;
  renamePin(id: string, label: string): Promise<Pin>;
  orderPins(ids: string[]): Promise<Pin[]>;
  removePin(id: string): Promise<void>;
  /** The Home page as an administrator would edit it: the draft, else the published page; null when there is none. */
  homePage(): Promise<PageDef | null>;
  saveHomeDraft(body: PageDef): Promise<void>;
}

/** One widget of a page, resolved for the person: what to draw and what to ask for. */
export type PlannedWidget =
  | { id: string; kind: 'groups' }
  | { id: string; kind: 'stat'; label: string; recordType: string; request: AggregateRequest; money: boolean }
  | { id: string; kind: 'chart'; label: string; chart: 'bar' | 'line'; recordType: string; request: AggregateRequest; money: boolean }
  | { id: string; kind: 'list'; label: string; spec: ListSpec; query: RecordQueryBody; link: string; pin?: Pin }
  | { id: string; kind: 'links'; label: string; items: { label: string; to: string }[] };

export interface PagePlan {
  key: string;
  label: string;
  widgets: PlannedWidget[];
}

/** What one widget shows once loaded; the same shape `ui/widget` draws. */
export type WidgetContent =
  | { kind: 'stat'; label: string; value: string }
  | { kind: 'chart'; label: string; chart: 'bar' | 'line'; buckets: Bucket[] }
  | { kind: 'list'; label: string; rows: RowView[]; link: string }
  | { kind: 'links'; label: string; items: { label: string; to: string }[] }
  | { kind: 'groups'; groups: GroupCard[] };

const inApp = (to: string) => to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\');
const inAudience = (page: PageDef, roles: readonly string[]) => !page.audience?.length || page.audience.some((r) => roles.includes(r));

export function listSpecFor(defs: RuntimeDefinitions | null, typeKey: string): ListSpec | null {
  const type = defs?.recordTypes.find((x) => x.key === typeKey);
  if (!defs || !type) return null;
  return resolveListSpec(type, defs.workflows[type.key], defs.listViews?.[type.key], {
    workflows: defs.workflowSets?.[type.key],
    actions: defs.actions?.[type.key],
    startingLayout: defs.listLayout,
  });
}

function typeOfListView(defs: RuntimeDefinitions | null, listView: string): string | undefined {
  return Object.values(defs?.listViews ?? {}).find((v) => v.key === listView)?.recordType;
}

/** Field filters as list criteria, for the filters the list offers; the rest cannot be written in its address. */
function filtersToCriteria(specs: FilterSpec[], filters: Record<string, FieldFilter> = {}): Criteria {
  const c: Criteria = {};
  for (const { field, kind } of specs) {
    const f = filters[field.key];
    if (!f) continue;
    const k = field.key;
    if (kind === 'list' && f.in?.length) c[k] = f.in.map(String);
    else if (kind === 'flag' && typeof f.eq === 'boolean') c[k] = f.eq;
    else if (kind === 'text' && (f.in?.length || (f.eq !== undefined && f.eq !== null))) c[k] = String(f.in?.[0] ?? f.eq);
    else if (kind === 'range' || kind === 'dateRange') {
      if (f.from !== undefined && f.from !== null) c[`${k}From`] = String(f.from);
      if (f.to !== undefined && f.to !== null) c[`${k}To`] = String(f.to);
    }
  }
  return c;
}

/** The address of a record list showing `state`, without an open record, panel or form. */
export function listAddress(spec: ListSpec, state: ListState): string {
  const shown: ListState = { ...state, view: undefined, show: spec.pageSize, filtersOpen: false, id: undefined, panel: { kind: 'view' }, create: undefined, createStep: 0, presets: {}, import: undefined, importStep: undefined };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(toQueryParams(shown, spec))) if (v !== null) params.set(k, v);
  const q = params.toString();
  return `/records/${encodeURIComponent(spec.type.key)}${q ? `?${q}` : ''}`;
}

/** Reads a list address back; null when it is not a list the person can open. */
function readAddress(defs: RuntimeDefinitions | null, address: string): { spec: ListSpec; state: ListState } | null {
  const m = /^\/records\/([^/?#]+)(?:\?([^#]*))?$/.exec(address);
  if (!m) return null;
  const spec = listSpecFor(defs, decodeURIComponent(m[1]!));
  if (!spec) return null;
  const params = new URLSearchParams(m[2] ?? '');
  return { spec, state: parseListUrl((n) => params.get(n), spec) };
}

function chipQuery(spec: ListSpec, chipId: string | undefined): Pick<AggregateRequest, 'statusIn' | 'owner' | 'sharedWithMe' | 'filters'> {
  const chip = chipId ? spec.chips.find((c) => c.id === chipId) : undefined;
  return {
    ...(chip?.statusIn ? { statusIn: chip.statusIn } : {}),
    ...(chip?.owner ? { owner: chip.owner } : {}),
    ...(chip?.sharedWithMe ? { sharedWithMe: true as const } : {}),
    ...(chip?.filters && Object.keys(chip.filters).length ? { filters: chip.filters } : {}),
  };
}

function viewRequest(spec: ListSpec, view: WidgetView | undefined): Pick<AggregateRequest, 'statusIn' | 'owner' | 'sharedWithMe' | 'filters'> {
  const out = chipQuery(spec, view?.chip);
  const filters = mergeFieldFilters(out.filters, view?.filters);
  return { ...out, ...(view?.owner ? { owner: view.owner } : {}), ...(Object.keys(filters).length ? { filters } : {}) };
}

function planList(id: string, label: string, spec: ListSpec, state: ListState, limit: number, extra: { view?: WidgetView; pin?: Pin; link?: string } = {}): PlannedWidget {
  const query = queryBody(spec, state, 0, limit);
  const filters = { ...extra.view?.filters, ...query.filters };
  return {
    id,
    kind: 'list',
    label,
    spec,
    query: { ...query, filters, ...(extra.view?.owner ? { owner: extra.view.owner } : {}) },
    link: extra.link ?? listAddress(spec, state),
    ...(extra.pin ? { pin: extra.pin } : {}),
  };
}

/** One widget resolved for the person; null when it names something they cannot read (or that does not exist). */
export function planWidget(defs: RuntimeDefinitions | null, page: string, w: PageWidget, position: number): PlannedWidget | null {
  const id = `w${w.index ?? position}`;
  const widget = w.index === undefined ? undefined : { page, index: w.index };
  const isMoney = (type: RuntimeRecordType | undefined, field?: string) => !!field && type?.fields.find((f) => f.key === field)?.type === 'money';
  switch (w.type) {
    case 'groups':
      return { id, kind: 'groups' };
    case 'stat':
    case 'chart': {
      const spec = listSpecFor(defs, w.recordType);
      if (!spec) return null;
      const request: AggregateRequest = {
        ...viewRequest(spec, w.view),
        measure: w.measure,
        ...(w.measure === 'sum' && w.field ? { field: w.field } : {}),
        ...(w.type === 'chart' ? { groupBy: w.groupBy } : {}),
        ...(widget ? { widget } : {}),
      };
      const money = w.measure === 'sum' && isMoney(spec.type, w.field);
      return w.type === 'stat'
        ? { id, kind: 'stat', label: w.label, recordType: w.recordType, request, money }
        : { id, kind: 'chart', label: w.label, chart: w.chart, recordType: w.recordType, request, money };
    }
    case 'list': {
      const type = typeOfListView(defs, w.listView);
      const spec = type ? listSpecFor(defs, type) : null;
      if (!spec) return null;
      const chip = w.view?.chip && spec.chips.some((c) => c.id === w.view!.chip) ? w.view.chip : spec.defaultChip;
      const state = parseListUrl(() => null, spec);
      return planList(id, w.label, spec, { ...state, chip, criteria: filtersToCriteria(spec.filters, w.view?.filters) }, Math.max(1, Math.min(w.limit || SHARED_PIN_ROWS, 20)), { view: w.view });
    }
    case 'links': {
      const items = w.items.filter((i) => inApp(i.to));
      return items.length ? { id, kind: 'links', label: w.label, items } : null;
    }
  }
}

/**
 * A page for the person: its widgets in order, those they cannot read left
 * out, and on Home their own pins first. Without a published Home page, Home
 * shows the record groups. Other pages outside the person's audience are null.
 */
export function planPage(defs: RuntimeDefinitions | null, key: string, roles: readonly string[], pins: readonly Pin[] = []): PagePlan | null {
  const found = defs?.pages?.find((p) => p.key === key);
  const page = found && inAudience(found, roles) ? found : undefined;
  if (key !== HOME_PAGE && !page) return null;
  const pinned =
    key === HOME_PAGE
      ? [...pins]
          .sort((a, b) => a.position - b.position)
          .flatMap((p) => {
            const read = readAddress(defs, p.address);
            return read ? [planList(`pin:${p.id}`, p.label, read.spec, read.state, PIN_ROWS, { pin: p, link: p.address })] : [];
          })
      : [];
  const widgets = page ? page.widgets.flatMap((w, i) => planWidget(defs, key, w, i) ?? []) : [{ id: 'groups', kind: 'groups' as const }];
  return { key, label: page?.label ?? '', widgets: [...pinned, ...widgets] };
}

/** The aggregate requests a page makes, by widget, in order. */
export function aggregateRequests(plan: PagePlan): { id: string; recordType: string; request: AggregateRequest }[] {
  return plan.widgets.flatMap((w) => (w.kind === 'stat' || w.kind === 'chart' ? [{ id: w.id, recordType: w.recordType, request: w.request }] : []));
}

/** How a widget's numbers are written: money with its symbol, counts plainly. */
export function widgetFormat(w: PlannedWidget): (n: number) => string {
  return (w.kind === 'stat' || w.kind === 'chart') && w.money ? formatMoney : (n) => formatNumber(n);
}

/** Chart axes and bar labels, short enough for the axis. */
export const compactNumber = (n: number): string => formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 });

/** What a widget shows before its data arrives. */
export function emptyContent(w: PlannedWidget, defs: RuntimeDefinitions | null): WidgetContent {
  switch (w.kind) {
    case 'groups':
      return { kind: 'groups', groups: homeGroups(defs) };
    case 'stat':
      return { kind: 'stat', label: w.label, value: '' };
    case 'chart':
      return { kind: 'chart', label: w.label, chart: w.chart, buckets: [] };
    case 'list':
      return { kind: 'list', label: w.label, rows: [], link: w.link };
    case 'links':
      return { kind: 'links', label: w.label, items: w.items };
  }
}

/** Loads one widget's figures or rows. Groups and links need nothing from the server. */
export async function loadWidget(
  w: PlannedWidget,
  gateways: { pages: Pick<PagesGateway, 'aggregate'>; records: Pick<RecordsGateway, 'query'> },
  defs: RuntimeDefinitions | null,
): Promise<WidgetContent> {
  if (w.kind === 'stat' || w.kind === 'chart') {
    const result = await gateways.pages.aggregate(w.recordType, w.request);
    if (w.kind === 'chart') return { kind: 'chart', label: w.label, chart: w.chart, buckets: 'buckets' in result ? result.buckets : [] };
    const value = 'value' in result ? result.value : result.buckets.reduce((n, b) => n + b.value, 0);
    return { kind: 'stat', label: w.label, value: widgetFormat(w)(value) };
  }
  if (w.kind === 'list') {
    const found = await gateways.records.query(w.spec.type.key, w.query);
    return { kind: 'list', label: w.label, rows: found.items.map((r) => plainRecordRow(w.spec, r)), link: w.link };
  }
  return emptyContent(w, defs);
}

/** A name for a pin, from the list's title, chip, search and filters. */
export function pinLabel(spec: ListSpec, state: ListState): string {
  const chip = spec.chips.find((c) => c.id === state.chip);
  const parts = [spec.title, ...(chip && chip.id !== 'all' ? [chip.label] : []), ...(state.q.trim() ? [`“${state.q.trim()}”`] : []), ...filterPills(spec.filters, state.criteria).map((p) => p.label)];
  const label = parts.join(' · ');
  return label.length > MAX_PIN_LABEL ? `${label.slice(0, MAX_PIN_LABEL - 1)}…` : label;
}

/** A personal pin for the list as it is shown. */
export function pinInput(spec: ListSpec, state: ListState, listView: string | undefined): PinInput {
  return { label: pinLabel(spec, state), listView: listView ?? spec.type.key, address: listAddress(spec, state) };
}

/**
 * The Home page with the list added for everyone, before the record groups,
 * ready to save as a draft. Search and sort are not part of a page widget.
 */
export function homeWithList(home: PageDef | null, spec: ListSpec, state: ListState, listView: string): PageDef {
  const filters = criteriaToFilters(spec.filters, state.criteria);
  const view: WidgetView = { ...(state.chip !== spec.defaultChip ? { chip: state.chip } : {}), ...(Object.keys(filters).length ? { filters } : {}) };
  const widget: PageWidget = { type: 'list', label: pinLabel(spec, state), listView, ...(Object.keys(view).length ? { view } : {}), limit: SHARED_PIN_ROWS };
  const page: PageDef = home ?? { key: HOME_PAGE, label: t('ui.nav.home'), widgets: [{ type: 'groups' }] };
  const widgets = page.widgets.map(({ index: _, ...w }) => w as PageWidget);
  const at = widgets.findIndex((w) => w.type === 'groups');
  widgets.splice(at < 0 ? widgets.length : at, 0, widget);
  return { ...page, widgets };
}

/** "Pin to my Home" for everyone; "Pin to everyone's Home" for those who publish, on lists with a published list view. */
export function pinEntries(canPublish: boolean, listView: string | undefined): { id: string; label: string }[] {
  return [{ id: 'pin', label: t('ui.pins.pinMine') }, ...(canPublish && listView ? [{ id: 'pinAll', label: t('ui.pins.pinEveryone') }] : [])];
}

/** Pins the list as shown, to the person's Home or into the Home page draft, and says what happened. */
export async function pinList(
  gateway: Pick<PagesGateway, 'addPin' | 'homePage' | 'saveHomeDraft'>,
  spec: ListSpec,
  state: ListState,
  listView: string | undefined,
  everyone: boolean,
): Promise<string> {
  if (everyone && listView) {
    await gateway.saveHomeDraft(homeWithList(await gateway.homePage(), spec, state, listView));
    return t('ui.pins.drafted');
  }
  const pin = await gateway.addPin(pinInput(spec, state, listView));
  return t('ui.pins.pinned', { label: pin.label });
}

/** Pin menu entries on Home: See all, Rename, Move up and down where they can move, then Unpin. */
export function pinMenu(pins: readonly Pin[], id: string): { id: string; label: string; divider?: boolean }[] {
  const ordered = [...pins].sort((a, b) => a.position - b.position);
  const at = ordered.findIndex((p) => p.id === id);
  if (at < 0) return [];
  return [
    { id: 'open', label: t('ui.common.seeAll') },
    { id: 'rename', label: t('ui.pins.rename') },
    ...(at > 0 ? [{ id: 'up', label: t('ui.pins.moveUp') }] : []),
    ...(at < ordered.length - 1 ? [{ id: 'down', label: t('ui.pins.moveDown') }] : []),
    { id: 'unpin', label: t('ui.pins.unpin'), divider: true },
  ];
}

/** The pin ids after moving one up or down by one place. */
export function movedPins(pins: readonly Pin[], id: string, by: -1 | 1): string[] {
  const ids = [...pins].sort((a, b) => a.position - b.position).map((p) => p.id);
  const at = ids.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= ids.length) return ids;
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  return ids;
}
