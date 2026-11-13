import type { ParamReader, Params, Sort } from '../address';
import { t } from '../i18n/i18n';
import type { ApprovalQueryBody, ApprovalRow, ApprovalSortField } from '../models';
import { PagedController, type PagedSnapshot } from '../paging/paged-controller';
import { decisionMessage } from '../records/record/actions';
import {
  APPROVAL_FILTERS,
  PAGE_SIZE,
  approvalsKey,
  defaultTab,
  inboxParams,
  inboxPushes,
  parseInboxAddress,
  patchInbox,
  type ApprovalFilter,
  type InboxAddress,
  type InboxChange,
  type InboxTab,
} from './address';
import type { InboxGateway } from './http-inbox';

export type ApprovalsSnapshot = PagedSnapshot<ApprovalRow>;

export interface InboxNavigator {
  /** Writes the Inbox parameters to the address bar; `replace` keeps the current history entry. */
  navigate(params: Params, replace: boolean): void;
}

export interface DecisionResult {
  ok: boolean;
  message: string;
}

/** The query the server is asked for one page of approvals. */
export function approvalQuery(a: InboxAddress, offset: number, limit: number): ApprovalQueryBody {
  const filters = Object.fromEntries(APPROVAL_FILTERS.filter((k) => a[k].length).map((k) => [k, a[k]]));
  return {
    ...(a.q && { search: a.q }),
    ...(Object.keys(filters).length && { filters }),
    ...(a.sort && { sort: { field: a.sort.field as ApprovalSortField, dir: a.sort.dir } }),
    offset,
    limit,
  };
}

const messageOf = (e: unknown, fallback: string) =>
  e && typeof e === 'object' && 'message' in e && 'code' in e ? String((e as { message: unknown }).message) : fallback;

/**
 * The Inbox's tab and approvals list, independent of how they are drawn.
 * State is read from the address bar; every intent becomes an address-bar
 * change that comes back through `fromUrl`. Cards and table use exactly these
 * intents. Decided requests leave the list and the waiting count follows.
 */
export class ApprovalsSession {
  readonly controller: PagedController<ApprovalRow, InboxAddress>;
  /** People who asked for the requests seen so far, by id, for the Requested by filter. */
  readonly requesters = new Map<string, string>();
  /** Record types of the requests seen so far, by record id, to open a notification's record. */
  readonly recordTypes = new Map<string, string>();
  private current: InboxAddress = parseInboxAddress(() => null);
  private waitingCount: number | null = null;
  private counting: Promise<number> | null = null;
  private readonly listeners = new Set<(a: InboxAddress) => void>();
  private readonly countListeners = new Set<(n: number | null) => void>();

  constructor(
    private readonly gateway: InboxGateway,
    private readonly nav: InboxNavigator,
  ) {
    this.controller = new PagedController({
      key: approvalsKey,
      show: (a) => a.show,
      load: (a, offset, limit) => gateway.queryApprovals(approvalQuery(a, offset, limit)),
      id: (r) => r.id,
      get failure() {
        return t('ui.inbox.loadFailed');
      },
    });
    this.controller.subscribe((s) => {
      for (const r of s.items) {
        this.requesters.set(r.requestedBy, r.requestedByName ?? r.requestedBy);
        this.recordTypes.set(r.recordId, r.recordType);
      }
    });
  }

  get state(): InboxAddress {
    return this.current;
  }

  get rows(): ApprovalsSnapshot {
    return this.controller.snapshot;
  }

  /** Approvals waiting for the person; null until known. */
  get waiting(): number | null {
    return this.waitingCount;
  }

  onState(fn: (a: InboxAddress) => void): () => void {
    this.listeners.add(fn);
    fn(this.current);
    return () => this.listeners.delete(fn);
  }

  onWaiting(fn: (n: number | null) => void): () => void {
    this.countListeners.add(fn);
    fn(this.waitingCount);
    return () => this.countListeners.delete(fn);
  }

  /** Reads the address. Without a tab it waits for the count and writes the default tab in place. */
  async fromUrl(get: ParamReader): Promise<void> {
    this.current = parseInboxAddress(get);
    for (const fn of this.listeners) fn(this.current);
    if (!this.current.tab) {
      const waiting = this.waitingCount ?? (await this.refreshCount());
      if (!this.current.tab) this.go({ tab: defaultTab(waiting) }, true);
      return;
    }
    if (this.current.tab === 'approvals') await this.controller.sync(this.current);
  }

  /** Asks the server how many approvals are waiting; a failure counts as none. */
  refreshCount(): Promise<number> {
    this.counting ??= this.gateway
      .countApprovals()
      .then((r) => r.waiting)
      .catch(() => this.waitingCount ?? 0)
      .then((n) => {
        this.counting = null;
        this.setWaiting(n);
        return n;
      });
    return this.counting;
  }

  /** Applies a change through the address bar. `replace` forces the current history entry to be replaced. */
  go(change: InboxChange, replace = false): void {
    const next = patchInbox(this.current, change);
    this.nav.navigate(inboxParams(next), replace || !inboxPushes(this.current, next));
  }

  // ------------------------------------------------------------- intents

  selectTab(tab: InboxTab): void {
    if (tab !== this.current.tab) this.go({ tab });
  }

  search(q: string): void {
    if (q.trim() !== this.current.q) this.go({ q: q.trim() });
  }

  applyFilters(values: Partial<Record<ApprovalFilter, string[]>>): void {
    this.go(Object.fromEntries(APPROVAL_FILTERS.map((k) => [k, values[k] ?? []])) as InboxChange);
  }

  removeFilter(key: ApprovalFilter): void {
    this.go({ [key]: [] } as InboxChange);
  }

  clearFilters(): void {
    this.applyFilters({});
  }

  setSort(sort: Sort | undefined): void {
    this.go({ sort });
  }

  /** Ascending, then descending, then the default (longest waiting first). */
  toggleSort(field: string): void {
    const s = this.current.sort;
    this.setSort(s?.field !== field ? { field, dir: 'asc' } : s.dir === 'asc' ? { field, dir: 'desc' } : undefined);
  }

  /** Asks for the next page; ignored while one is loading or when everything is shown. */
  loadMore(): void {
    const r = this.rows;
    if (!r.hasMore || r.loading || r.loadingMore || r.error) return;
    this.go({ show: Math.max(this.current.show, r.items.length) + PAGE_SIZE });
  }

  retry(): Promise<void> {
    return this.controller.retry();
  }

  /** Records the person's decision. The request leaves the list whatever the outcome, unless the call fails. */
  async decide(approvalId: string, decision: 'approve' | 'reject', reason?: string): Promise<DecisionResult> {
    try {
      const out = await this.gateway.decide(approvalId, decision, reason?.trim() || undefined);
      this.controller.removeRow(approvalId);
      if (this.waitingCount !== null) this.setWaiting(Math.max(0, this.waitingCount - 1));
      void this.refreshCount();
      return { ok: true, message: out.status === 'stale' ? (out.message ?? t('ui.approval.stale')) : decisionMessage(out.status) };
    } catch (e) {
      return { ok: false, message: messageOf(e, t('ui.inbox.decideFailed')) };
    }
  }

  private setWaiting(n: number): void {
    this.waitingCount = n;
    for (const fn of this.countListeners) fn(n);
  }
}
