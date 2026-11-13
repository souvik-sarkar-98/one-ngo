import { t } from '../i18n/i18n';
import type { InboxNotification } from '../models';
import { PAGE_SIZE } from './address';
import type { InboxGateway } from './http-inbox';

export interface NotificationsSnapshot {
  /** Newest first. */
  items: InboxNotification[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string;
  /** Unread notifications, counted up to `UNREAD_LIMIT`; null until known. */
  unread: number | null;
}

/** Unread notifications are counted up to here; the chip shows "99+" beyond. */
export const UNREAD_LIMIT = 100;

const messageOf = (e: unknown, fallback: string) =>
  e && typeof e === 'object' && 'message' in e && 'code' in e ? String((e as { message: unknown }).message) : fallback;

/**
 * The person's notifications, newest first, a page at a time. Each page asks
 * for one more than it shows, to know whether there is another, and continues
 * after the last one shown. Answers to an older load are dropped.
 */
export class NotificationsFeed {
  private snap: NotificationsSnapshot = { items: [], loading: false, loadingMore: false, hasMore: false, error: '', unread: null };
  private readonly listeners = new Set<(s: NotificationsSnapshot) => void>();
  private generation = 0;

  constructor(
    private readonly gateway: InboxGateway,
    private readonly pageSize = PAGE_SIZE,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get snapshot(): NotificationsSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: NotificationsSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** Loads the first page again. */
  load(): Promise<void> {
    return this.page(true);
  }

  loadMore(): Promise<void> {
    const s = this.snap;
    if (!s.hasMore || s.loading || s.loadingMore || s.error) return Promise.resolve();
    return this.page(false);
  }

  retry(): Promise<void> {
    return this.page(!this.snap.items.length);
  }

  async countUnread(): Promise<void> {
    try {
      const unread = await this.gateway.notifications({ unreadOnly: true, limit: UNREAD_LIMIT });
      this.set({ unread: unread.length });
    } catch {
      // The chip shows no count when it cannot be had.
    }
  }

  /** Marks one notification read at once; the server is told in the background. */
  async markRead(id: string): Promise<void> {
    const n = this.snap.items.find((x) => x.id === id);
    if (!n || n.readAt) return;
    const at = this.clock().toISOString();
    this.set({
      items: this.snap.items.map((x) => (x.id === id ? { ...x, readAt: at } : x)),
      unread: this.snap.unread === null ? null : Math.max(0, this.snap.unread - 1),
    });
    await this.gateway.markRead(id).catch(() => undefined);
  }

  /** Marks every notification read; returns a message when it fails. */
  async markAllRead(): Promise<string | null> {
    try {
      await this.gateway.markAllRead();
      const at = this.clock().toISOString();
      this.set({ items: this.snap.items.map((x) => (x.readAt ? x : { ...x, readAt: at })), unread: 0 });
      return null;
    } catch (e) {
      return messageOf(e, t('ui.inbox.markAllFailed'));
    }
  }

  private async page(first: boolean): Promise<void> {
    const run = ++this.generation;
    const before = first ? undefined : this.snap.items.at(-1)?.id;
    this.set(first ? { loading: true, loadingMore: false, error: '' } : { loadingMore: true, error: '' });
    try {
      const got = await this.gateway.notifications({ limit: this.pageSize + 1, ...(before && { before }) });
      if (run !== this.generation) return;
      const page = got.slice(0, this.pageSize);
      this.set({ items: first ? page : [...this.snap.items, ...page], hasMore: got.length > this.pageSize, loading: false, loadingMore: false });
    } catch (e) {
      if (run !== this.generation) return;
      this.set({ loading: false, loadingMore: false, error: messageOf(e, t('ui.inbox.loadFailed')) });
    }
  }

  private set(change: Partial<NotificationsSnapshot>): void {
    this.snap = { ...this.snap, ...change };
    for (const fn of this.listeners) fn(this.snap);
  }
}
