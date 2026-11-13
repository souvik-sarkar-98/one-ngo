import { t } from '../../i18n/i18n';
import type { PageDef, PageWidget, WidgetView } from '../../models';
import type { RowView } from '../../rows';
import { moveItem } from '../../ui-logic/reorder';

export const WIDGET_TYPES = ['stat', 'chart', 'list', 'links', 'groups'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type GroupBy = Extract<PageWidget, { type: 'chart' }>['groupBy'];
export type PageLinkItem = Extract<PageWidget, { type: 'links' }>['items'][number];

type Loose = Record<string, unknown>;

export const widgetTypeName = (type: string): string => t(`ui.builder.page.type.${type}`);

/** A new widget that the page's rules accept as it is; the record type, view or field is chosen afterwards. */
export function newWidget(type: WidgetType, label = widgetTypeName(type)): PageWidget {
  switch (type) {
    case 'stat':
      return { type, label, recordType: '', measure: 'count' };
    case 'chart':
      return { type, label, recordType: '', measure: 'count', groupBy: { period: 'month', dateField: 'createdAt' }, chart: 'bar' };
    case 'list':
      return { type, label, listView: '', limit: 5 };
    case 'links':
      return { type, label, items: [{ label: t('ui.builder.page.newLink'), to: '/' }] };
    case 'groups':
      return { type };
  }
}

const widgets = (page: PageDef) => page.widgets.map(({ index: _, ...w }) => w as PageWidget);
const withWidgets = (page: PageDef, list: PageWidget[]): PageDef => ({ ...page, widgets: list });
const update = (page: PageDef, index: number, fn: (w: PageWidget) => PageWidget): PageDef =>
  withWidgets(page, widgets(page).map((w, i) => (i === index ? fn(w) : w)));
/** Optional settings left empty are removed rather than saved blank. */
const tidy = <T extends Loose>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null)) as T;

export function setLabel(page: PageDef, label: string): PageDef {
  return { ...page, label };
}

/** Roles that see the page; none means everyone. */
export function setAudience(page: PageDef, roles: readonly string[]): PageDef {
  const { audience: _, ...rest } = page;
  const unique = [...new Set(roles)];
  return unique.length ? { ...rest, audience: unique } : rest;
}

export function toggleAudience(page: PageDef, role: string, on: boolean): PageDef {
  const now = (page.audience ?? []).filter((r) => r !== role);
  return setAudience(page, on ? [...now, role] : now);
}

export function addWidget(page: PageDef, type: WidgetType): PageDef {
  return withWidgets(page, [...widgets(page), newWidget(type)]);
}

export function removeWidget(page: PageDef, index: number): PageDef {
  return withWidgets(page, widgets(page).filter((_, i) => i !== index));
}

export function moveWidget(page: PageDef, from: number, to: number): PageDef {
  return withWidgets(page, moveItem(widgets(page), from, to));
}

/** Changes a widget's settings; empty optional settings are dropped, and counting drops the field to total. */
export function setWidget(page: PageDef, index: number, patch: Loose): PageDef {
  return update(page, index, (w) => {
    const next = tidy({ ...w, ...patch } as Loose);
    if (next['measure'] === 'count') delete next['field'];
    return next as PageWidget;
  });
}

/** Another kind of widget in the same place, keeping the label, record type, view and permission where the new kind has them. */
export function changeWidgetType(page: PageDef, index: number, type: WidgetType): PageDef {
  return update(page, index, (w) => {
    if (w.type === type) return w;
    const old = w as Loose;
    const fresh = newWidget(type, typeof old['label'] === 'string' && old['label'] ? (old['label'] as string) : undefined) as Loose;
    const keep = ['permission', ...(type === 'stat' || type === 'chart' ? ['recordType', 'measure', 'field', 'view'] : [])];
    for (const k of keep) if (old[k] !== undefined) fresh[k] = old[k];
    if (fresh['measure'] !== 'sum') delete fresh['field'];
    return fresh as PageWidget;
  });
}

/** Which records a widget counts or lists: a chip, only the person's own, filters. An empty view is removed. */
export function setWidgetView(page: PageDef, index: number, patch: Partial<WidgetView>): PageDef {
  return update(page, index, (w) => {
    const old = (w as { view?: WidgetView }).view ?? {};
    const view = tidy({ ...old, ...patch } as Loose) as WidgetView;
    if (view.filters && !Object.keys(view.filters).length) delete view.filters;
    const { view: _, ...rest } = w as PageWidget & { view?: WidgetView };
    return (Object.keys(view).length ? { ...rest, view } : rest) as PageWidget;
  });
}

export function setGroupBy(page: PageDef, index: number, groupBy: GroupBy): PageDef {
  return update(page, index, (w) => (w.type === 'chart' ? { ...w, groupBy } : w));
}

/** A permission the widget needs besides the page audience; empty removes it. */
export function setWidgetPermission(page: PageDef, index: number, permission: string): PageDef {
  return setWidget(page, index, { permission: permission.trim() || undefined });
}

const updateLinks = (page: PageDef, index: number, fn: (items: PageLinkItem[]) => PageLinkItem[]): PageDef =>
  update(page, index, (w) => (w.type === 'links' ? { ...w, items: fn(w.items.map((i) => ({ ...i }))) } : w));

export function addLink(page: PageDef, index: number): PageDef {
  return updateLinks(page, index, (items) => [...items, { label: t('ui.builder.page.newLink'), to: '/' }]);
}

/** Changes a link; an empty permission is removed, so the link shows to everyone who sees the widget. */
export function setLink(page: PageDef, index: number, item: number, patch: Partial<PageLinkItem>): PageDef {
  return updateLinks(page, index, (items) => items.map((x, i) => (i === item ? (tidy({ ...x, ...patch, ...(patch.permission !== undefined && { permission: patch.permission.trim() }) }) as PageLinkItem) : x)));
}

/** Removes a link; a links widget keeps at least one. */
export function removeLink(page: PageDef, index: number, item: number): PageDef {
  return updateLinks(page, index, (items) => (items.length > 1 ? items.filter((_, i) => i !== item) : items));
}

export function moveLink(page: PageDef, index: number, from: number, to: number): PageDef {
  return updateLinks(page, index, (items) => moveItem(items, from, to));
}

/** Names of what widgets refer to, for the table; keys are shown for anything unknown. */
export interface WidgetNames {
  recordType(key: string): string | undefined;
  field(recordType: string, key: string): string | undefined;
  listView(key: string): string | undefined;
  chip(recordType: string, chip: string): string | undefined;
}

function viewText(w: { view?: WidgetView }, recordType: string, names: WidgetNames): string[] {
  const v = w.view;
  if (!v) return [];
  const filters = Object.keys(v.filters ?? {}).length;
  return [
    ...(v.chip ? [t('ui.builder.page.shows.chip', { chip: names.chip(recordType, v.chip) ?? v.chip })] : []),
    ...(v.owner === 'me' ? [t('ui.builder.schema.enum.me')] : []),
    ...(filters ? [t('ui.builder.page.shows.filters', { count: filters })] : []),
  ];
}

/** What a widget shows, in a few words: "Total of Amount · Donation · chip Outstanding". */
export function widgetSummary(w: PageWidget, names: WidgetNames): string {
  switch (w.type) {
    case 'groups':
      return t('ui.builder.page.shows.groups');
    case 'links':
      return t('ui.builder.page.shows.links', { count: w.items.length });
    case 'list': {
      const listView = w.listView ? (names.listView(w.listView) ?? w.listView) : t('ui.builder.page.shows.none');
      return [t('ui.builder.page.shows.list', { view: listView, count: w.limit }), ...viewText(w, '', names)].join(' · ');
    }
    case 'stat':
    case 'chart': {
      if (!w.recordType) return t('ui.builder.page.shows.none');
      const type = names.recordType(w.recordType) ?? w.recordType;
      const measure = w.measure === 'sum' ? t('ui.builder.page.shows.sum', { field: (w.field && names.field(w.recordType, w.field)) || w.field || '?' }) : t('ui.builder.page.shows.count');
      const parts = [measure, type];
      if (w.type === 'chart') {
        const by = 'field' in w.groupBy ? (names.field(w.recordType, w.groupBy.field) ?? w.groupBy.field) : t(`ui.builder.schema.enum.${w.groupBy.period}`);
        parts.push(t('ui.builder.page.shows.by', { by }), t(`ui.builder.schema.enum.${w.chart}`));
      }
      return [...parts, ...viewText(w, w.recordType, names)].join(' · ');
    }
  }
}

/** The widgets table: one row per widget, named by its place so selection follows it while it moves. */
export function widgetRows(page: PageDef, names: WidgetNames): RowView[] {
  return widgets(page).map((w, i) => {
    const type = widgetTypeName(w.type);
    const label = 'label' in w && w.label ? w.label : type;
    return {
      id: String(i),
      title: label,
      badge: { label: type, tone: 'primary' },
      cells: [
        { key: 'title', label: t('ui.builder.label'), value: label },
        { key: 'type', label: t('ui.builder.schema.prop.type'), value: type },
        { key: 'shows', label: t('ui.builder.page.shows.title'), value: widgetSummary(w, names) },
        { key: 'permission', label: t('ui.builder.schema.prop.permission'), value: w.permission ?? '' },
      ],
      actions: [],
    };
  });
}
