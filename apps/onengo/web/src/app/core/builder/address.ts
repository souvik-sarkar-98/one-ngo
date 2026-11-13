import { list, oneOf, sort, text, type ParamReader, type Params, type Sort } from '../address';
import { DEFINITION_KINDS, type DefinitionKind } from '../models';

export const EDITOR_TABS = ['visual', 'json', 'changes', 'history'] as const;
/** Pages inside a hand-built Visual tab, addressed like tabs: `?tab=rules`. */
export const VISUAL_PAGES = ['rules', 'lookups', 'usedBy', 'workflows'] as const;
export type VisualPage = (typeof VISUAL_PAGES)[number];
export type EditorTab = (typeof EDITOR_TABS)[number] | VisualPage;

/** The frame tab a tab belongs to: Visual pages are on the Visual tab. */
export const frameTab = (tab: EditorTab): (typeof EDITOR_TABS)[number] => ((VISUAL_PAGES as readonly string[]).includes(tab) ? 'visual' : (tab as (typeof EDITOR_TABS)[number]));

/** What is open in a definition editor: the tab and, on the Visual tab, the selected part. */
export interface EditorAddress {
  tab: EditorTab;
  field?: string;
  step?: string;
  section?: string;
  widget?: string;
  create: boolean;
}

const TAB = oneOf([...EDITOR_TABS, ...VISUAL_PAGES]);
const NAME = text();

export function parseEditorAddress(get: ParamReader): EditorAddress {
  return {
    tab: TAB.read(get, 'tab') ?? 'visual',
    ...(NAME.read(get, 'field') !== undefined && { field: NAME.read(get, 'field') }),
    ...(NAME.read(get, 'step') !== undefined && { step: NAME.read(get, 'step') }),
    ...(NAME.read(get, 'section') !== undefined && { section: NAME.read(get, 'section') }),
    ...(NAME.read(get, 'widget') !== undefined && { widget: NAME.read(get, 'widget') }),
    create: get('create') !== null,
  };
}

/** Parameters for a new tab: the Visual tab is the default and is not written, and a selection belongs to it only. */
export function tabParams(tab: EditorTab): Params {
  return { tab: tab === 'visual' ? null : tab, field: null, step: null, section: null, widget: null, create: null };
}

/** Parameters selecting one part on the Visual tab; selecting nothing clears them. */
export function selectionParams(sel: { field?: string; step?: string; section?: string; widget?: string; create?: boolean }): Params {
  return {
    tab: null,
    field: sel.field ?? null,
    step: sel.step ?? null,
    section: sel.section ?? null,
    widget: sel.widget ?? null,
    create: sel.create ? '' : null,
  };
}

export const ORIGINS = ['module', 'organisation'] as const;
export type Origin = (typeof ORIGINS)[number];
export const STATES = ['draft', 'published'] as const;
export type DefinitionState = (typeof STATES)[number];
export const CATALOGUE_SORTS = ['label', 'kind', 'key', 'state'] as const;

/** The catalogue's chip, search, sort and filters. */
export interface CatalogueAddress {
  kind?: DefinitionKind;
  q: string;
  sort?: Sort;
  from: Origin[];
  state: DefinitionState[];
}

const KIND = oneOf(DEFINITION_KINDS);
const SORT = sort(CATALOGUE_SORTS);
const FROM = list(ORIGINS);
const STATE = list(STATES);

export function parseCatalogueAddress(get: ParamReader): CatalogueAddress {
  const kind = KIND.read(get, 'kind');
  const s = SORT.read(get, 'sort');
  return {
    ...(kind && { kind }),
    q: NAME.read(get, 'q') ?? '',
    ...(s && { sort: s }),
    from: (FROM.read(get, 'from') ?? []) as Origin[],
    state: (STATE.read(get, 'state') ?? []) as DefinitionState[],
  };
}

/** The parameters to write for a change; every catalogue change replaces the address. */
export function catalogueParams(change: Partial<CatalogueAddress>): Params {
  const out: Params = {};
  if ('kind' in change) Object.assign(out, KIND.write('kind', change.kind));
  if ('q' in change) Object.assign(out, NAME.write('q', change.q || undefined));
  if ('sort' in change) Object.assign(out, SORT.write('sort', change.sort));
  if ('from' in change) Object.assign(out, FROM.write('from', change.from));
  if ('state' in change) Object.assign(out, STATE.write('state', change.state));
  return out;
}

/** Ascending, then descending, then no sort. */
export function nextSort(current: Sort | undefined, field: string): Sort | undefined {
  if (current?.field !== field) return { field, dir: 'asc' };
  return current.dir === 'asc' ? { field, dir: 'desc' } : undefined;
}
