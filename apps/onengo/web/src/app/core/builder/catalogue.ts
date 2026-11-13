import { t } from '../i18n/i18n';
import type { CatalogueItem, DefinitionKind, Me } from '../models';
import type { RowView } from '../rows';
import { kindName, starterBody } from '../starters';
import type { CatalogueAddress, Origin } from './address';
import { holds } from './permission-grid';

/** Builder home sections. Access and the modules page are their own routes. */
export const BUILDER_SECTIONS: { id: string; kinds: readonly DefinitionKind[] }[] = [
  { id: 'data', kinds: ['recordType', 'recordGroup', 'listView', 'dataFeed'] },
  { id: 'process', kinds: ['workflow', 'action', 'automation'] },
  { id: 'templates', kinds: ['template', 'report', 'reportGroup'] },
  { id: 'money', kinds: ['postingRule', 'receiptRule'] },
  { id: 'look', kinds: ['theme', 'page', 'translation'] },
  { id: 'advanced', kinds: ['script'] },
];

/** The kinds in the order the catalogue chips and the "+ New" menu show them. */
export const CATALOGUE_KINDS: readonly DefinitionKind[] = [
  'recordType',
  'workflow',
  'listView',
  'recordGroup',
  'template',
  'automation',
  'postingRule',
  'receiptRule',
  'script',
  'theme',
  'action',
  'page',
  'report',
  'reportGroup',
  'translation',
  'dataFeed',
];

/** Kinds that belong to one record type, chosen when one is created. */
const FOR_RECORD_TYPE = new Set<DefinitionKind>(['workflow', 'listView', 'recordGroup', 'automation', 'postingRule', 'receiptRule', 'script', 'action']);
/** Kinds whose body carries a `label`, filled from the name given when one is created. */
const LABELLED = new Set<DefinitionKind>(['recordType', 'listView', 'recordGroup', 'action', 'page', 'theme', 'report', 'reportGroup', 'dataFeed']);

export const needsRecordType = (kind: DefinitionKind): boolean => FOR_RECORD_TYPE.has(kind);

export const kindsName = (kind: DefinitionKind): string => t(`ui.builder.kinds.${kind}`);

/** One row of the Builder home. `href` is either a kind list or a screen that opens directly. */
export interface BuilderHomeRow {
  id: string;
  labelKey: string;
  hintKey: string;
  href: string;
  /** The permission that lets a person change what this row opens. Without it the row opens read-only, for people who may look (`config:read`). */
  changeNeeds?: 'scripts' | 'modules';
}

/** Whether the row opens read-only for this person: they lack the permission that changes what it opens. */
export function homeRowReadOnly(row: Pick<BuilderHomeRow, 'changeNeeds'>, me: Pick<Me, 'capabilities' | 'permissions'> | null | undefined): boolean {
  if (!row.changeNeeds) return false;
  if (!me) return true;
  return row.changeNeeds === 'scripts' ? !me.capabilities.scripts : !holds(me.permissions, 'config:modules');
}

export interface BuilderHomeGroup {
  id: string;
  labelKey: string;
  rows: BuilderHomeRow[];
}

/** A kind page shows a search field once it has more definitions than this. */
export const KIND_SEARCH_AT = 8;

const kindHome = (kind: DefinitionKind, labelKey = `ui.builder.kinds.${kind}`): BuilderHomeRow => ({
  id: kind,
  labelKey,
  hintKey: `ui.builder.home.hint.${kind}`,
  href: `/builder?kind=${kind}`,
});

/** The Builder home: the same groups as Administration, one caption and a list of rows. */
export function builderHome(): BuilderHomeGroup[] {
  return [
    {
      id: 'data',
      labelKey: 'ui.builder.sections.data',
      rows: [kindHome('recordType'), kindHome('listView', 'ui.builder.home.lists'), kindHome('recordGroup'), kindHome('dataFeed')],
    },
    {
      id: 'process',
      labelKey: 'ui.builder.sections.process',
      rows: [kindHome('workflow'), kindHome('action'), kindHome('automation')],
    },
    {
      id: 'templates',
      labelKey: 'ui.builder.sections.templates',
      rows: [kindHome('template'), kindHome('report', 'ui.builder.home.templates.report')],
    },
    {
      id: 'money',
      labelKey: 'ui.builder.sections.money',
      rows: [kindHome('postingRule'), kindHome('receiptRule')],
    },
    {
      id: 'look',
      labelKey: 'ui.builder.sections.look',
      rows: [
        { id: 'theme', labelKey: 'ui.builder.look.theme', hintKey: 'ui.builder.look.themeHint', href: '/builder/theme' },
        { id: 'layout', labelKey: 'ui.builder.look.layout', hintKey: 'ui.builder.look.layoutHint', href: '/builder/layout' },
        kindHome('page'),
        { id: 'translation', labelKey: 'ui.builder.kinds.translation', hintKey: 'ui.builder.home.hint.translation', href: '/builder/translations' },
      ],
    },
    {
      id: 'access',
      labelKey: 'ui.builder.sections.access',
      rows: [{ id: 'access', labelKey: 'ui.builder.sections.access', hintKey: 'ui.builder.home.hint.access', href: '/builder/access' }],
    },
    {
      id: 'advanced',
      labelKey: 'ui.builder.sections.advanced',
      rows: [
        { ...kindHome('script'), changeNeeds: 'scripts' },
        { id: 'modules', labelKey: 'ui.crumbs.builder.modules', hintKey: 'ui.builder.advanced.modulesHint', href: '/builder/modules', changeNeeds: 'modules' },
      ],
    },
  ];
}

/** The home group and row for a Builder screen, matched by its row id or its address. */
export function builderPlace(id: string): { group: BuilderHomeGroup; row: BuilderHomeRow } | undefined {
  for (const group of builderHome()) {
    const row = group.rows.find((item) => item.id === id || item.href === `/builder/${id}`);
    if (row) return { group, row };
  }
  return undefined;
}

/** Title, hint and the New link for a kind's own page. */
export function kindPageCopy(kind: DefinitionKind): { titleKey: string; hintKey: string; createKey: string } {
  const row = builderHome()
    .flatMap((group) => group.rows)
    .find((item) => item.id === kind && item.href.includes(`kind=${kind}`));
  return {
    titleKey: row?.labelKey ?? `ui.builder.kinds.${kind}`,
    hintKey: row?.hintKey ?? `ui.builder.home.hint.${kind}`,
    createKey: `ui.builder.home.new.${kind}`,
  };
}

export const originOf = (item: CatalogueItem): Origin => (item.owner === 'base' ? 'module' : 'organisation');

export function originLabel(item: CatalogueItem): string {
  return item.owner === 'base' ? t('ui.builder.catalogue.fromModule', { module: item.moduleKey ?? '' }) : t('ui.builder.catalogue.fromOrganisation');
}

export function stateLabel(item: CatalogueItem): string {
  const parts: string[] = [];
  if (item.publishedVersion) parts.push(t('ui.common.version', { version: item.publishedVersion }));
  if (item.draftVersion) parts.push(t('ui.builder.draftVersion', { version: item.draftVersion }));
  return parts.join(' · ');
}

/** The line under a definition on a kind page: its version, and the module when it shipped with one. */
export function catalogueHint(item: CatalogueItem): string {
  const state = stateLabel(item);
  if (item.owner !== 'base') return state || originLabel(item);
  const from = originLabel(item);
  return state ? `${state} · ${from}` : from;
}

/** "All" and one chip per kind, each with its count. */
export function kindChips(items: CatalogueItem[]): { id: string; label: string }[] {
  const count = (k: DefinitionKind) => items.filter((i) => i.kind === k).length;
  return [
    { id: 'all', label: t('ui.builder.catalogue.chip', { label: t('ui.builder.catalogue.all'), count: items.length }) },
    ...CATALOGUE_KINDS.map((k) => ({ id: k, label: t('ui.builder.catalogue.chip', { label: kindsName(k), count: count(k) }) })),
  ];
}

const labelOf = (i: CatalogueItem) => i.label || i.key;
const rank = (k: DefinitionKind) => CATALOGUE_KINDS.indexOf(k);
const stateRank = (i: CatalogueItem) => (i.draftVersion ? 0 : 1);

/** The definitions the chip, search and filters keep, sorted; by kind then name when no sort is chosen. */
export function filterCatalogue(items: CatalogueItem[], a: CatalogueAddress): CatalogueItem[] {
  const q = a.q.toLowerCase();
  const kept = items.filter(
    (i) =>
      (!a.kind || i.kind === a.kind) &&
      (!q || labelOf(i).toLowerCase().includes(q) || i.key.toLowerCase().includes(q)) &&
      (!a.from.length || a.from.includes(originOf(i))) &&
      (!a.state.length || (a.state.includes('draft') && !!i.draftVersion) || (a.state.includes('published') && !!i.publishedVersion)),
  );
  const byName = (x: CatalogueItem, y: CatalogueItem) => labelOf(x).localeCompare(labelOf(y));
  const compare: Record<string, (x: CatalogueItem, y: CatalogueItem) => number> = {
    label: byName,
    kind: (x, y) => rank(x.kind) - rank(y.kind) || byName(x, y),
    key: (x, y) => x.key.localeCompare(y.key),
    state: (x, y) => stateRank(x) - stateRank(y) || byName(x, y),
  };
  const s = a.sort;
  const cmp = s ? compare[s.field]! : compare['kind']!;
  const dir = s?.dir === 'desc' ? -1 : 1;
  return [...kept].sort((x, y) => dir * cmp(x, y));
}

export type CatalogueAction = 'open' | 'history' | 'duplicate' | 'revert' | 'deleteDraft';

/** The row menu: duplicating needs something to copy; reverting is for module definitions; only drafts can be deleted. */
export function rowActions(item: CatalogueItem, canPublish: boolean): { id: CatalogueAction; label: string }[] {
  const out: { id: CatalogueAction; label: string }[] = [
    { id: 'open', label: t('ui.builder.catalogue.open') },
    { id: 'history', label: t('ui.builder.history') },
  ];
  if (!canPublish) return out;
  out.push({ id: 'duplicate', label: t('ui.builder.catalogue.duplicate') });
  if (item.owner === 'base') out.push({ id: 'revert', label: t('ui.builder.revertToModule') });
  if (item.draftVersion && item.owner !== 'base') out.push({ id: 'deleteDraft', label: t('ui.builder.catalogue.deleteDraft') });
  return out;
}

export const rowId = (item: Pick<CatalogueItem, 'kind' | 'key'>): string => `${item.kind}/${item.key}`;

/** One definition as the catalogue's table and cards draw it. */
export function catalogueRow(item: CatalogueItem, canPublish: boolean): RowView {
  const state = stateLabel(item);
  return {
    id: rowId(item),
    title: labelOf(item),
    subtitle: `${kindName(item.kind)} · ${item.key}`,
    meta: originLabel(item),
    ...(state && { badge: { label: state, tone: item.draftVersion ? 'warning' : 'success' } }),
    cells: [
      { key: 'label', label: t('ui.builder.name'), value: labelOf(item) },
      { key: 'kind', label: t('ui.builder.kindLabel'), value: kindName(item.kind) },
      { key: 'key', label: t('ui.builder.key'), value: item.key },
      { key: 'from', label: t('ui.builder.catalogue.from'), value: originLabel(item) },
      { key: 'state', label: t('ui.builder.catalogue.state'), value: state },
    ],
    actions: rowActions(item, canPublish),
  };
}

type Body = Record<string, unknown>;

const field = (key: string, type: string, required = false) => ({ key, label: t(`ui.builder.starters.field.${key}`), type, ...(required && { required: true }) });

/** Ready-made record types to start from. */
export const RECORD_TYPE_STARTERS: readonly { id: string; fields: () => Body[] }[] = [
  {
    id: 'beneficiary',
    fields: () => [field('name', 'text', true), field('phone', 'phone'), field('dateOfBirth', 'date'), field('address', 'longText')],
  },
  {
    id: 'expense',
    fields: () => [field('description', 'text', true), field('amount', 'money', true), field('date', 'date', true), field('paidTo', 'text')],
  },
  {
    id: 'asset',
    fields: () => [field('name', 'text', true), field('tag', 'text'), field('purchaseDate', 'date'), field('value', 'money'), field('location', 'text')],
  },
];

export const starterName = (id: string): string => t(`ui.builder.starters.${id}`);

/** The first draft of a new definition: the kind's starter, or a ready-made record type, with the name given. */
export function newDefinitionBody(kind: DefinitionKind, key: string, name: string, opts: { recordType?: string; starter?: string } = {}): Body {
  const body = starterBody(kind, key, opts.recordType ?? '');
  const starter = kind === 'recordType' ? RECORD_TYPE_STARTERS.find((s) => s.id === opts.starter) : undefined;
  if (starter) {
    const fields = starter.fields();
    Object.assign(body, { fields, titleField: fields[0]!['key'] });
  }
  if (LABELLED.has(kind)) body['label'] = name.trim();
  return body;
}

/** A copy of a definition under a new key and name. */
export function duplicateBody(kind: DefinitionKind, body: Body, key: string, name: string): Body {
  const copy = structuredClone(body);
  copy['key'] = key;
  if (LABELLED.has(kind)) copy['label'] = name.trim();
  return copy;
}
