import { t } from '../i18n/i18n';
import { asGatewayError } from '../records/gateway/gateway';
import { Snapshots, type AdminGateway, type DeletedRecord } from './admin';
import { failure, type AdminResult } from './roles';

/** Deleted records come in pages of this size. */
export const BIN_PAGE = 25;

export interface RecycleBinSnapshot {
  items: DeletedRecord[];
  /** How many deleted records match the search, beyond those loaded. */
  total: number;
  /** The text the list is searched for on the server. */
  q: string;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  /** A restore is running. */
  busy: boolean;
  /** The record whose restore is being confirmed in the panel. */
  restoring: DeletedRecord | null;
  /** What the server said about a refused restore, shown in the panel. */
  restoreError: string;
}

/** What a deleted record is called in the list and in messages: its title, else its number. */
export function binName(r: DeletedRecord): string {
  return r.title || r.number || t('ui.admin.bin.untitled');
}

/**
 * Administration › Recycle bin (`/admin/recycle-bin`): records an administrator deleted, newest first,
 * searched on the server, restored after a confirmation. A restore the server refuses (a unique value
 * was taken, a record it refers to is still deleted, someone else changed it) says why and changes nothing.
 */
export class RecycleBinSession {
  readonly state = new Snapshots<RecycleBinSnapshot>({
    items: [],
    total: 0,
    q: '',
    loading: false,
    loadingMore: false,
    error: '',
    busy: false,
    restoring: null,
    restoreError: '',
  });
  /** Each load takes a number; an answer that is not the latest load's is dropped, so a slow search never overwrites a newer one. */
  private latest = 0;

  constructor(private readonly gateway: AdminGateway) {}

  async load(): Promise<void> {
    const mine = ++this.latest;
    this.state.set({ loading: true, loadingMore: false, error: '' });
    try {
      const page = await this.gateway.deletedRecords({ q: this.state.value.q || undefined, limit: BIN_PAGE, offset: 0 });
      if (mine === this.latest) this.state.set({ items: page.items, total: page.total, loading: false });
    } catch (e) {
      if (mine === this.latest) this.state.set({ loading: false, error: failure(e) });
    }
  }

  async search(q: string): Promise<void> {
    if (q.trim() === this.state.value.q) return;
    this.state.set({ q: q.trim() });
    await this.load();
  }

  hasMore(): boolean {
    const s = this.state.value;
    return s.items.length < s.total;
  }

  async loadMore(): Promise<void> {
    const s = this.state.value;
    if (!this.hasMore() || s.loading || s.loadingMore) return;
    const mine = ++this.latest;
    this.state.set({ loadingMore: true, error: '' });
    try {
      const page = await this.gateway.deletedRecords({ q: s.q || undefined, limit: BIN_PAGE, offset: s.items.length });
      if (mine === this.latest) this.state.set({ items: [...this.state.value.items, ...page.items], total: page.total, loadingMore: false });
    } catch (e) {
      if (mine === this.latest) this.state.set({ loadingMore: false, error: failure(e) });
    }
  }

  askRestore(id: string): void {
    this.state.set({ restoring: this.state.value.items.find((r) => r.id === id) ?? null, restoreError: '' });
  }

  cancelRestore(): void {
    this.state.set({ restoring: null, restoreError: '' });
  }

  async confirmRestore(): Promise<AdminResult> {
    const record = this.state.value.restoring;
    if (!record) return { ok: false, message: '' };
    this.state.set({ busy: true, restoreError: '' });
    try {
      await this.gateway.restoreRecord(record.id, record.version);
      const s = this.state.value;
      this.state.set({ busy: false, restoring: null, items: s.items.filter((r) => r.id !== record.id), total: Math.max(s.total - 1, 0) });
      return { ok: true, message: t('ui.admin.bin.restoredMsg', { name: binName(record) }) };
    } catch (e) {
      // The panel says why. When someone else changed or restored the record, the list is out of date, so it is read again.
      const err = asGatewayError(e, t('ui.common.somethingWentWrong'));
      this.state.set({ busy: false, restoreError: err.message });
      if (err.code === 'conflict' || err.code === 'not_found') void this.load();
      return { ok: false, message: '' };
    }
  }
}
