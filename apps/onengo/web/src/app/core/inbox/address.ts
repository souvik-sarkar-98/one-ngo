import { depth, list, oneOf, sort, text, type ParamReader, type Params, type Sort } from '../address';
import type { ApprovalSortField } from '../models';

export const INBOX_TABS = ['approvals', 'notifications'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];
export const APPROVAL_SORTS: readonly ApprovalSortField[] = ['waiting', 'record', 'type', 'step', 'requestedBy'];
export const APPROVAL_FILTERS = ['type', 'step', 'requestedBy'] as const;
export type ApprovalFilter = (typeof APPROVAL_FILTERS)[number];
export const PAGE_SIZE = 20;
const MAX_SHOW = 200;

/** Longest waiting first, when the address names no sort. */
export const DEFAULT_SORT: Sort = { field: 'waiting', dir: 'desc' };

/** The Inbox address (Architecture §4): the tab, and the approvals list's search, filters, sort and depth. */
export interface InboxAddress {
  /** Absent until chosen; the screen then opens on the default tab. */
  tab?: InboxTab;
  q: string;
  type: string[];
  step: string[];
  requestedBy: string[];
  sort?: Sort;
  show: number;
}

export type InboxChange = Partial<InboxAddress>;

const TAB = oneOf(INBOX_TABS);
const Q = text();
const LIST = list();
const SORT = sort(APPROVAL_SORTS);
const SHOW = depth(PAGE_SIZE, MAX_SHOW);

export const INBOX_PARAMS = ['tab', 'q', ...APPROVAL_FILTERS, 'sort', 'show'] as const;

export function parseInboxAddress(get: ParamReader): InboxAddress {
  const tab = TAB.read(get, 'tab');
  const s = SORT.read(get, 'sort');
  return {
    ...(tab && { tab }),
    q: Q.read(get, 'q') ?? '',
    type: LIST.read(get, 'type') ?? [],
    step: LIST.read(get, 'step') ?? [],
    requestedBy: LIST.read(get, 'requestedBy') ?? [],
    ...(s && { sort: s }),
    show: SHOW.read(get, 'show') ?? PAGE_SIZE,
  };
}

/** Applies a change; a new search, filter or sort starts again from the first page. */
export function patchInbox(current: InboxAddress, change: InboxChange): InboxAddress {
  const next = { ...current, ...change };
  const relists = ['q', 'sort', ...APPROVAL_FILTERS].some((k) => k in change);
  return relists && !('show' in change) ? { ...next, show: PAGE_SIZE } : next;
}

/** Every parameter the Inbox owns, with null for the ones to remove; other parameters are left alone. */
export function inboxParams(a: InboxAddress): Params {
  return {
    ...TAB.write('tab', a.tab),
    ...Q.write('q', a.q || undefined),
    ...LIST.write('type', a.type),
    ...LIST.write('step', a.step),
    ...LIST.write('requestedBy', a.requestedBy),
    ...SORT.write('sort', a.sort),
    ...SHOW.write('show', a.show),
  };
}

/** Changing the tab adds a history entry; everything else replaces the current one. */
export function inboxPushes(current: InboxAddress, next: InboxAddress): boolean {
  return current.tab !== undefined && next.tab !== current.tab;
}

/** What the approvals list shows: equal keys list the same rows. */
export function approvalsKey(a: InboxAddress): string {
  return JSON.stringify([a.q, a.type, a.step, a.requestedBy, a.sort ?? DEFAULT_SORT]);
}

/** Approvals when anything is waiting, otherwise Notifications. */
export function defaultTab(waiting: number): InboxTab {
  return waiting > 0 ? 'approvals' : 'notifications';
}
