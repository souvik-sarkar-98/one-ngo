import { depth, list, oneOf, sort, text, type ParamReader, type Params, type Sort } from '../address';

/** The people list is Administration → People. There is no `/people` route. */
export type PeopleVariant = 'directory' | 'management';

export const STATUS_CHIPS = ['active', 'invited', 'suspended', 'all'] as const;
export type StatusChip = (typeof STATUS_CHIPS)[number];
export const DIRECTORY_SORTS = ['name'] as const;
export const MANAGEMENT_SORTS = ['name', 'joined', 'status'] as const;
export const PAGE_SIZE = 30;
const MAX_SHOW = 300;

/** Parameters the People screen owns. */
export const PEOPLE_PARAMS = ['status', 'role', 'q', 'sort', 'show', 'person', 'add'] as const;

/**
 * The People address on `/admin/people`: role, search, sort, and the open person,
 * plus status and add.
 */
export interface PeopleAddress {
  status: StatusChip;
  q: string;
  role: string[];
  sort?: Sort;
  show: number;
  person?: string;
  add: boolean;
}

export type PeopleChange = Partial<PeopleAddress>;

const STATUS = oneOf(STATUS_CHIPS);
const Q = text();
const LIST = list();
const SHOW = depth(PAGE_SIZE, MAX_SHOW);
const PERSON = text();
const sorter = (v: PeopleVariant) => sort(v === 'directory' ? DIRECTORY_SORTS : MANAGEMENT_SORTS);

/** Reads the address. Management owns status and Add; the directory ignores them. */
export function parsePeopleAddress(get: ParamReader, variant: PeopleVariant): PeopleAddress {
  const s = sorter(variant).read(get, 'sort');
  const person = PERSON.read(get, 'person');
  return {
    status: variant === 'management' ? (STATUS.read(get, 'status') ?? 'active') : 'active',
    q: Q.read(get, 'q') ?? '',
    role: LIST.read(get, 'role') ?? [],
    ...(s && { sort: s }),
    show: SHOW.read(get, 'show') ?? PAGE_SIZE,
    ...(person && { person }),
    add: variant === 'management' && get('add') !== null,
  };
}

/** Applies a change; a new chip, search, filter or sort starts again from the first page. */
export function patchPeople(current: PeopleAddress, change: PeopleChange): PeopleAddress {
  const next = { ...current, ...change };
  const relists = ['status', 'q', 'role', 'sort'].some((k) => k in change);
  return relists && !('show' in change) ? { ...next, show: PAGE_SIZE } : next;
}

/** Every parameter the screen owns, with null for those to remove. */
export function peopleParams(a: PeopleAddress, variant: PeopleVariant): Params {
  return {
    ...(variant === 'management' ? { status: a.status === 'active' ? null : a.status, add: a.add ? '' : null } : {}),
    ...Q.write('q', a.q || undefined),
    ...LIST.write('role', a.role),
    ...sorter(variant).write('sort', a.sort),
    ...SHOW.write('show', a.show),
    ...PERSON.write('person', a.person),
  };
}

/** Opening a person or Add a person adds a history entry. Closing it replaces that entry, so Back does not open it again. */
export function peoplePushes(current: PeopleAddress, next: PeopleAddress): boolean {
  const open = (a: PeopleAddress) => !!a.person || a.add;
  return !open(current) && open(next);
}

/** What is listed: equal keys list the same people. */
export function peopleKey(a: PeopleAddress, variant: PeopleVariant): string {
  return JSON.stringify([variant, variant === 'management' ? a.status : '', a.q, a.role, a.sort ?? null]);
}
