export interface Page<T> {
  items: T[];
  total: number;
}

/** Where a paged list gets its rows from, for a query of type `Q`. */
export interface PageSource<T, Q> {
  /** Equal keys list the same rows; a new key starts again from the first page. */
  key(query: Q): string;
  /** How many rows the query asks to have loaded. */
  show(query: Q): number;
  load(query: Q, offset: number, limit: number): Promise<Page<T>>;
  id(item: T): string;
  /** Shown when a load fails without a message of its own. */
  failure: string;
}

export interface PagedSnapshot<T> {
  items: T[];
  total: number;
  /** First page of a new query is loading. */
  loading: boolean;
  /** A further page is loading. */
  loadingMore: boolean;
  hasMore: boolean;
  error: string;
}

function messageOf(e: unknown, fallback: string): string {
  return e && typeof e === 'object' && 'message' in e && 'code' in e ? String((e as { message: unknown }).message) : fallback;
}

/**
 * Keeps the loaded rows in step with a query. It reloads only when what is
 * listed changes, appends pages as `show` grows, never has two requests for
 * the same list in flight, and drops answers to old queries.
 */
export class PagedController<T, Q> {
  private snap: PagedSnapshot<T> = { items: [], total: 0, loading: false, loadingMore: false, hasMore: false, error: '' };
  private readonly listeners = new Set<(s: PagedSnapshot<T>) => void>();
  private key: string | null = null;
  private query: Q | null = null;
  private generation = 0;
  private inFlight = false;

  constructor(private readonly source: PageSource<T, Q>) {}

  get snapshot(): PagedSnapshot<T> {
    return this.snap;
  }

  subscribe(fn: (s: PagedSnapshot<T>) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** Brings the rows in line with a new query. */
  sync(query: Q): Promise<void> {
    this.query = query;
    const key = this.source.key(query);
    if (key !== this.key) {
      this.key = key;
      return this.load(0, this.source.show(query));
    }
    return this.fill();
  }

  retry(): Promise<void> {
    if (this.query === null) return Promise.resolve();
    if (!this.snap.items.length) return this.load(0, this.source.show(this.query));
    this.set({ error: '' });
    return this.fill();
  }

  reload(): Promise<void> {
    if (this.query === null) return Promise.resolve();
    return this.load(0, Math.max(this.source.show(this.query), this.snap.items.length));
  }

  /** Puts a changed item in place of its row. */
  replaceRow(item: T): void {
    const id = this.source.id(item);
    if (!this.snap.items.some((r) => this.source.id(r) === id)) return;
    this.set({ items: this.snap.items.map((r) => (this.source.id(r) === id ? item : r)) });
  }

  /** Adds a new item at the top. */
  prependRow(item: T): void {
    const id = this.source.id(item);
    if (this.snap.items.some((r) => this.source.id(r) === id)) return this.replaceRow(item);
    this.set({ items: [item, ...this.snap.items], total: this.snap.total + 1 });
  }

  /** Takes a row out of the list, for example a decided request. */
  removeRow(id: string): void {
    if (!this.snap.items.some((r) => this.source.id(r) === id)) return;
    const items = this.snap.items.filter((r) => this.source.id(r) !== id);
    const total = Math.max(items.length, this.snap.total - 1);
    this.set({ items, total, hasMore: items.length < total });
  }

  private fill(): Promise<void> {
    const want = this.query === null ? 0 : this.source.show(this.query);
    const have = this.snap.items.length;
    if (this.inFlight || this.snap.loading || !this.snap.hasMore || want <= have || this.snap.error) return Promise.resolve();
    return this.load(have, want - have);
  }

  private async load(offset: number, limit: number): Promise<void> {
    const query = this.query as Q;
    const run = ++this.generation;
    const first = offset === 0;
    this.inFlight = true;
    this.set(first ? { loading: true, loadingMore: false, error: '' } : { loadingMore: true, error: '' });
    try {
      const res = await this.source.load(query, offset, limit);
      if (run !== this.generation) return;
      const items = first ? res.items : [...this.snap.items, ...res.items];
      this.inFlight = false;
      this.set({ items, total: res.total, loading: false, loadingMore: false, hasMore: items.length < res.total && res.items.length > 0 });
      await this.fill();
    } catch (e) {
      if (run !== this.generation) return;
      this.inFlight = false;
      this.set({ loading: false, loadingMore: false, error: messageOf(e, this.source.failure) });
    }
  }

  private set(change: Partial<PagedSnapshot<T>>): void {
    this.snap = { ...this.snap, ...change };
    for (const fn of this.listeners) fn(this.snap);
  }
}
