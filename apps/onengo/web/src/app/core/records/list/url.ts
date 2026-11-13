import { depth, flag, list, oneOf, range, roundDepth, sort, text, type Codec, type ParamReader, type Range, type Sort } from '../../address';
import type { ListLayout } from '../../models';
import { MAX_ROWS, type FilterKind, type FilterSpec, type ListSpec } from '../spec';

export type { Sort } from '../../address';

/** Filter values as the list holds them; ranges use `<key>From` / `<key>To`. */
export type Criteria = Record<string, string | string[] | boolean>;

export type PanelMode = { kind: 'view' } | { kind: 'edit' } | { kind: 'step'; step: string } | { kind: 'action'; action: string } | { kind: 'share' };

/** Everything on a list screen. The address bar is the only place it is kept. */
export interface ListState {
  view?: ListLayout;
  chip: string;
  q: string;
  criteria: Criteria;
  sort?: Sort;
  show: number;
  filtersOpen: boolean;
  id?: string;
  panel: PanelMode;
  create?: string;
  createStep: number;
  presets: Record<string, string>;
  /** The import in the panel: `new` until a file is uploaded, then the import's id. */
  import?: string;
  importStep?: number;
}

export type ListChange = Partial<Omit<ListState, 'criteria' | 'presets'>> & {
  criteria?: Criteria;
  presets?: Record<string, string>;
};

const isRange = (kind: FilterKind) => kind === 'range' || kind === 'dateRange';

function filterCodec({ field, kind }: FilterSpec): Codec<string | string[] | boolean | Range> {
  switch (kind) {
    case 'range':
      return range('number');
    case 'dateRange':
      return range('date');
    case 'list':
      return list((field.choices ?? []).map((o) => o.value));
    case 'flag':
      return flag();
    default:
      return text({ trim: false });
  }
}

const VIEW = oneOf<ListLayout>(['cards', 'table']);
const TEXT = text();
const FILTERS_OPEN = flag('open', null);

/** The parameters this list owns; anything else in the address bar is left alone. */
export function ownedParams(spec: ListSpec): string[] {
  return [
    'view',
    'chip',
    'q',
    'sort',
    'show',
    'filters',
    'id',
    'panel',
    'create',
    'createStep',
    'import',
    'importStep',
    'importId',
    ...filterParams(spec.filters),
    ...spec.presets.map((p) => p.param),
  ];
}

function filterParams(specs: FilterSpec[]): string[] {
  return specs.flatMap((s) => filterCodec(s).names(s.field.key));
}

export function criteriaFromParams(specs: FilterSpec[], get: ParamReader): Criteria {
  const c: Criteria = {};
  for (const s of specs) {
    const k = s.field.key;
    const v = filterCodec(s).read(get, k);
    if (v === undefined) continue;
    if (isRange(s.kind)) {
      const { from, to } = v as Range;
      if (from !== undefined) c[k + 'From'] = from;
      if (to !== undefined) c[k + 'To'] = to;
    } else c[k] = v as string | string[] | boolean;
  }
  return c;
}

export function paramsFromCriteria(specs: FilterSpec[], c: Criteria): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of specs) {
    const k = s.field.key;
    const value = isRange(s.kind) ? ({ from: c[`${k}From`], to: c[`${k}To`] } as Range) : c[k];
    Object.assign(out, filterCodec(s).write(k, value));
  }
  return out;
}

/** Criteria without one filter (both ends of a range). */
export function withoutFilter(c: Criteria, key: string): Criteria {
  const next = { ...c };
  delete next[key];
  delete next[`${key}From`];
  delete next[`${key}To`];
  return next;
}

const showCodec = (spec: ListSpec) => depth(spec.pageSize, MAX_ROWS);
const sortCodec = (spec: ListSpec) => sort(spec.sortable);

function parsePanel(raw: string | null, spec: ListSpec): PanelMode {
  if (raw === 'edit') return { kind: 'edit' };
  if (raw === 'share' && spec.type.visibility === 'restricted') return { kind: 'share' };
  if (raw?.startsWith('step:')) {
    const step = raw.slice(5);
    if (spec.workflows.some((w) => w.transitions.some((t) => t.key === step))) return { kind: 'step', step };
  }
  if (raw?.startsWith('action:')) {
    const action = raw.slice(7);
    if (spec.actions.some((a) => a.key === action)) return { kind: 'action', action };
  }
  return { kind: 'view' };
}

function writePanel(panel: PanelMode): string | null {
  switch (panel.kind) {
    case 'edit':
      return 'edit';
    case 'share':
      return 'share';
    case 'step':
      return `step:${panel.step}`;
    case 'action':
      return `action:${panel.action}`;
    default:
      return null;
  }
}

/** Reads the list state from address-bar parameters. Anything invalid is dropped, so a bad link still opens. */
export function parseListUrl(get: ParamReader, spec: ListSpec): ListState {
  const id = TEXT.read(get, 'id');
  const create = !id && spec.type.canCreate ? TEXT.read(get, 'create') : undefined;
  const createStep = Number(get('createStep'));
  const presets: Record<string, string> = {};
  if (create) for (const p of spec.presets) {
    const v = get(p.param);
    if (v) presets[p.param] = v;
  }
  const imported = !id && !create && spec.canImport !== false ? readImport(get) : undefined;
  return {
    view: VIEW.read(get, 'view'),
    chip: oneOf(spec.chips.map((c) => c.id)).read(get, 'chip') ?? spec.defaultChip,
    q: TEXT.read(get, 'q') ?? '',
    criteria: criteriaFromParams(spec.filters, get),
    sort: sortCodec(spec).read(get, 'sort'),
    show: showCodec(spec).read(get, 'show') ?? spec.pageSize,
    filtersOpen: FILTERS_OPEN.read(get, 'filters') === true,
    id,
    panel: id ? parsePanel(get('panel'), spec) : { kind: 'view' },
    create,
    createStep:
      create && Number.isInteger(createStep) && createStep > 0 && createStep < Math.max(1, spec.createSteps.length) ? createStep : 0,
    presets,
    ...imported,
  };
}

/** The last step of the import stepper (the result); counted from 0 like the create steps. */
export const LAST_IMPORT_STEP = 4;

/** `import=new` before upload, then `import=<id>&importStep=n`; `import=new&importId=<id>` is read the same. */
function readImport(get: ParamReader): { import: string; importStep: number } | undefined {
  const raw = TEXT.read(get, 'import');
  if (!raw) return undefined;
  const value = raw === 'new' ? (TEXT.read(get, 'importId') ?? 'new') : raw;
  const step = Number(get('importStep'));
  return { import: value, importStep: value !== 'new' && Number.isInteger(step) && step > 0 ? Math.min(step, LAST_IMPORT_STEP) : 0 };
}

/** Address-bar parameters for a state. Every owned parameter is present; null removes it. */
export function toQueryParams(state: ListState, spec: ListSpec): Record<string, string | null> {
  const out: Record<string, string | null> = Object.fromEntries(ownedParams(spec).map((p) => [p, null]));
  Object.assign(
    out,
    paramsFromCriteria(spec.filters, state.criteria),
    VIEW.write('view', state.view),
    TEXT.write('chip', state.chip !== spec.defaultChip ? state.chip : undefined),
    TEXT.write('q', state.q),
    sortCodec(spec).write('sort', state.sort),
    showCodec(spec).write('show', state.show),
    FILTERS_OPEN.write('filters', state.filtersOpen),
  );
  out['id'] = state.id ?? null;
  out['panel'] = state.id ? writePanel(state.panel) : null;
  out['create'] = !state.id && state.create ? state.create : null;
  out['createStep'] = !state.id && state.create && state.createStep > 0 ? String(state.createStep) : null;
  if (!state.id && state.create) for (const [k, v] of Object.entries(state.presets)) out[k] = v;
  const imported = !state.id && !state.create ? state.import : undefined;
  out['import'] = imported ?? null;
  out['importStep'] = imported && imported !== 'new' && state.importStep ? String(state.importStep) : null;
  return out;
}

const QUERY_KEYS = ['chip', 'q', 'criteria', 'sort'] as const;

/**
 * Applies a change. Changing what is listed (chip, search, filters, sort)
 * starts again from the first page; opening a record closes create and the
 * other way round.
 */
export function patch(state: ListState, change: ListChange, spec: ListSpec): ListState {
  const next: ListState = { ...state, ...change } as ListState;
  if (QUERY_KEYS.some((k) => k in change && JSON.stringify(change[k]) !== JSON.stringify(state[k]))) next.show = spec.pageSize;
  if ('show' in change) next.show = roundDepth(next.show, spec.pageSize, MAX_ROWS);
  if ('id' in change) {
    if (change.id) {
      next.create = undefined;
      next.createStep = 0;
      next.presets = {};
    }
    if (!('panel' in change) || !change.id) next.panel = change.panel && change.id ? change.panel : { kind: 'view' };
  }
  if ('create' in change && change.create) {
    next.id = undefined;
    next.panel = { kind: 'view' };
  }
  if ('create' in change && !change.create) {
    next.createStep = 0;
    next.presets = {};
  }
  if ('import' in change && change.import) {
    Object.assign(next, { id: undefined, panel: { kind: 'view' }, create: undefined, createStep: 0, presets: {}, importStep: next.importStep ?? 0 });
  } else if (next.id || next.create || 'import' in change) {
    next.import = undefined;
    next.importStep = undefined;
  }
  return next;
}

/** A record, the create form, or an import is open. */
function overlayOpen(state: ListState): boolean {
  return !!state.id || !!state.create || state.import !== undefined;
}

/**
 * Opening a record, create form, or import adds one history entry, so Back
 * closes it. Closing it, or moving inside it, replaces that entry, so Back
 * after it has been closed does not open it again.
 */
export function pushesHistory(before: ListState, after: ListState): boolean {
  return !overlayOpen(before) && overlayOpen(after);
}

/** The part of the state that decides which records are listed. */
export function queryKey(state: ListState): string {
  return JSON.stringify([state.chip, state.q, Object.entries(state.criteria).sort(([a], [b]) => a.localeCompare(b)), state.sort ?? null]);
}
