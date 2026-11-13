import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { APPROVAL_FILTERS, DEFAULT_SORT, type ApprovalFilter, type InboxAddress, type InboxTab } from '../core/inbox/address';
import { ApprovalsSession, type ApprovalsSnapshot } from '../core/inbox/approvals-session';
import { httpInbox } from '../core/inbox/http-inbox';
import { NotificationsFeed, type NotificationsSnapshot } from '../core/inbox/notifications';
import {
  approvalColumns,
  approvalFilters,
  approvalPills,
  approvalRow,
  approvalSortOptions,
  inboxChips,
  notificationAddress,
  notificationRow,
  recordAddress,
  tabLabel,
} from '../core/inbox/rows';
import type { ApprovalRow } from '../core/models';
import type { FormValues } from '../core/records/record/forms';
import type { Notice } from '../records/notice';
import { DebouncedSearch } from '../records/search';
import { Api } from '../services/api';
import { I18n } from '../services/i18n';
import { ScreenMeta } from '../services/screen-meta';
import { Session } from '../services/session';
import { Viewport } from '../ui/viewport';

const EMPTY: ApprovalsSnapshot = { items: [], total: 0, loading: true, loadingMore: false, hasMore: false, error: '' };

/**
 * Angular wrapper around the Inbox: the approvals session and the
 * notifications feed as signals. It reads the address bar, writes every
 * intent back to it, opens records, and is the only place the Inbox reaches
 * the router or the server. It draws no breadcrumb; it tells the shell the
 * tab's label through `ScreenMeta`.
 */
@Injectable()
export class InboxStore {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(Session);
  private readonly i18n = inject(I18n);
  private readonly meta = inject(ScreenMeta);
  private readonly gateway = httpInbox(inject(Api));
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private feedLoaded = false;

  readonly approvals = new ApprovalsSession(this.gateway, {
    navigate: (queryParams, replaceUrl) => void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl }),
  });
  readonly feed = new NotificationsFeed(this.gateway);

  readonly state = signal<InboxAddress>(this.approvals.state);
  readonly rows = signal<ApprovalsSnapshot>(EMPTY);
  readonly notifications = signal<NotificationsSnapshot>(this.feed.snapshot);
  /** Approvals waiting for the person, for the chip (and the shell's badge). */
  readonly waiting = signal<number | null>(null);
  readonly notice = signal<Notice | null>(null);
  readonly filtersOpen = signal(false);
  readonly deciding = signal(false);
  /** The request whose Reject panel is open. */
  readonly rejecting = signal<ApprovalRow | null>(null);
  readonly reason = signal('');

  readonly narrow = inject(Viewport).narrow;
  /** Cards on phones, a table on wider screens. */
  readonly layout = computed(() => (this.narrow() ? 'cards' : 'table'));
  /** Undefined while the default tab is being chosen. */
  readonly tab = computed(() => this.state().tab);
  /** The breadcrumb's last item, shown by the shell: Approvals or Notifications. */
  readonly tabLabel = computed(() => {
    this.i18n.locale();
    const tab = this.tab();
    return tab ? tabLabel(tab) : null;
  });
  readonly chips = computed(() => {
    this.i18n.locale();
    return inboxChips(this.waiting(), this.notifications().unread);
  });
  readonly columns = computed(() => {
    this.i18n.locale();
    return approvalColumns();
  });
  readonly sortOptions = computed(() => {
    this.i18n.locale();
    return approvalSortOptions();
  });
  readonly sort = computed(() => this.state().sort ?? DEFAULT_SORT);
  readonly approvalRows = computed(() => {
    this.i18n.locale();
    const now = new Date();
    return this.rows().items.map((a) => approvalRow(a, now));
  });
  readonly notificationRows = computed(() => {
    this.i18n.locale();
    const now = new Date();
    return this.notifications().items.map((n) => notificationRow(n, now));
  });
  readonly filters = computed(() => {
    this.rows();
    this.i18n.locale();
    return approvalFilters(this.session.defs(), this.approvals.requesters, this.state());
  });
  readonly pills = computed(() => approvalPills(this.state(), this.filters()));
  readonly filterValues = computed<FormValues>(() => {
    const s = this.state();
    return Object.fromEntries(APPROVAL_FILTERS.map((k) => [k, s[k]]));
  });
  readonly hasUnread = computed(() => this.notifications().items.some((n) => !n.readAt) || !!this.notifications().unread);

  /** Search text as typed; the search runs after a pause. */
  readonly search = new DebouncedSearch(() => this.approvals);

  constructor() {
    const detach = [
      this.approvals.onState((s) => this.state.set(s)),
      this.approvals.controller.subscribe((s) => this.rows.set(s)),
      this.approvals.onWaiting((n) => this.waiting.set(n)),
      this.feed.subscribe((s) => this.notifications.set(s)),
    ];
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => void this.approvals.fromUrl((n) => p.get(n)));
    void this.approvals.refreshCount();
    void this.feed.countUnread();
    effect(() => this.search.sync(this.state().q));
    effect(() => {
      if (this.tab() === 'notifications' && !this.feedLoaded) {
        this.feedLoaded = true;
        untracked(() => void this.feed.load());
      }
    });
    effect(() => {
      const label = this.tabLabel();
      untracked(() => this.meta.crumbLabel.set(label));
    });
    inject(DestroyRef).onDestroy(() => {
      detach.forEach((d) => d());
      this.search.dispose();
      clearTimeout(this.noticeTimer);
      this.meta.clear();
    });
  }

  selectTab(id: string): void {
    this.approvals.selectTab(id as InboxTab);
  }

  // ------------------------------------------------------------- approvals

  /** Opens the request's record in its list, with the request at the top of the record panel. */
  openApproval(id: string): void {
    const a = this.rows().items.find((r) => r.id === id);
    if (a) void this.router.navigateByUrl(recordAddress(a.recordType, a.recordId));
  }

  rowAction(id: string, action: string): void {
    const a = this.rows().items.find((r) => r.id === id);
    if (!a) return;
    if (action === 'approve') void this.decide(a.id, 'approve');
    else if (action === 'reject') {
      this.reason.set('');
      this.rejecting.set(a);
    }
  }

  cancelReject(): void {
    this.rejecting.set(null);
  }

  async confirmReject(): Promise<void> {
    const a = this.rejecting();
    if (!a) return;
    if (await this.decide(a.id, 'reject', this.reason())) this.rejecting.set(null);
  }

  openFilters(): void {
    this.filtersOpen.set(true);
  }

  closeFilters(): void {
    this.filtersOpen.set(false);
  }

  applyFilters(values: FormValues): void {
    const pick = (k: ApprovalFilter) => (Array.isArray(values[k]) ? (values[k] as unknown[]).map(String) : []);
    this.filtersOpen.set(false);
    this.approvals.applyFilters(Object.fromEntries(APPROVAL_FILTERS.map((k) => [k, pick(k)])));
  }

  removeFilter(id: string): void {
    if ((APPROVAL_FILTERS as readonly string[]).includes(id)) this.approvals.removeFilter(id as ApprovalFilter);
  }

  clearFilters(): void {
    this.filtersOpen.set(false);
    this.approvals.clearFilters();
  }

  toggleSort(field: string): void {
    this.approvals.toggleSort(field);
  }

  loadMore(): void {
    this.approvals.loadMore();
  }

  retry(): void {
    void this.approvals.retry();
  }

  // --------------------------------------------------------- notifications

  /** Marks the notification read and opens what it points at, when the app can tell. */
  openNotification(id: string): void {
    const n = this.notifications().items.find((x) => x.id === id);
    if (!n) return;
    void this.feed.markRead(id);
    const target = notificationAddress(n, (recordId) => this.approvals.recordTypes.get(recordId));
    if (target) void this.router.navigateByUrl(target);
  }

  async markAllRead(): Promise<void> {
    const failed = await this.feed.markAllRead();
    if (failed) this.show({ level: 'error', message: failed });
  }

  loadMoreNotifications(): void {
    void this.feed.loadMore();
  }

  retryNotifications(): void {
    void this.feed.retry();
  }

  private async decide(id: string, decision: 'approve' | 'reject', reason?: string): Promise<boolean> {
    this.deciding.set(true);
    const out = await this.approvals.decide(id, decision, reason);
    this.deciding.set(false);
    this.show({ level: out.ok ? 'success' : 'error', message: out.message });
    return out.ok;
  }

  private show(n: Notice): void {
    this.notice.set(n);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), n.level === 'error' ? 8000 : 4000);
  }
}
