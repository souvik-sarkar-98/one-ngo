import type { ListLayout } from '../../models';
import type { RecordsGateway } from '../gateway/gateway';
import { ListController, type ListSnapshot } from './list-controller';
import type { ListSpec } from '../spec';
import {
  parseListUrl,
  patch,
  pushesHistory,
  toQueryParams,
  withoutFilter,
  type Criteria,
  type ListChange,
  type ListState,
  type PanelMode,
  type Sort,
} from './url';

export interface Navigator {
  /** Writes the list's parameters to the address bar; `replace` keeps the current history entry. */
  navigate(params: Record<string, string | null>, replace: boolean): void;
}

export interface LayoutMemory {
  preferred(): ListLayout;
  remember(layout: ListLayout): void;
}

/**
 * One list screen, independent of how it is drawn. State is read from the
 * address bar; every user intent becomes an address-bar change, which comes
 * back through `fromUrl`. Both the cards and the table layout use exactly
 * these intents, so they behave the same.
 */
export class ListSession {
  readonly controller: ListController;
  private current: ListState;
  private readonly listeners = new Set<(s: ListState) => void>();

  constructor(
    readonly spec: ListSpec,
    gateway: RecordsGateway,
    private readonly nav: Navigator,
    private readonly layout: LayoutMemory,
  ) {
    this.controller = new ListController(gateway, spec);
    this.current = parseListUrl(() => null, spec);
  }

  get state(): ListState {
    return this.current;
  }

  get rows(): ListSnapshot {
    return this.controller.snapshot;
  }

  /** The layout shown: the address bar's, else this person's last choice, else the list view's default. */
  get view(): ListLayout {
    return this.current.view ?? this.layout.preferred();
  }

  onState(fn: (s: ListState) => void): () => void {
    this.listeners.add(fn);
    fn(this.current);
    return () => this.listeners.delete(fn);
  }

  fromUrl(get: (name: string) => string | null): Promise<void> {
    this.current = parseListUrl(get, this.spec);
    for (const fn of this.listeners) fn(this.current);
    return this.controller.sync(this.current);
  }

  /** Applies a change through the address bar. `replace` forces the current history entry to be replaced. */
  go(change: ListChange, replace = false): void {
    const next = patch(this.current, change, this.spec);
    if (change.view) this.layout.remember(change.view);
    this.nav.navigate(toQueryParams(next, this.spec), replace || !pushesHistory(this.current, next));
  }

  // ------------------------------------------------------------- intents

  setView(view: ListLayout): void {
    if (view !== this.view) this.go({ view });
  }

  selectChip(chip: string): void {
    if (chip !== this.current.chip) this.go({ chip });
  }

  search(q: string): void {
    if (q.trim() !== this.current.q) this.go({ q: q.trim() });
  }

  openFilters(): void {
    this.go({ filtersOpen: true });
  }

  closeFilters(): void {
    this.go({ filtersOpen: false });
  }

  applyFilters(criteria: Criteria): void {
    this.go({ criteria, filtersOpen: false });
  }

  removeFilter(key: string): void {
    this.go({ criteria: withoutFilter(this.current.criteria, key) });
  }

  clearFilters(): void {
    this.go({ criteria: {}, filtersOpen: false });
  }

  setSort(sort: Sort | undefined): void {
    this.go({ sort });
  }

  /** Ascending, then descending, then unsorted. */
  toggleSort(field: string): void {
    const s = this.current.sort;
    this.setSort(s?.field !== field ? { field, dir: 'asc' } : s.dir === 'asc' ? { field, dir: 'desc' } : undefined);
  }

  /** Asks for the next page; ignored while one is loading or when everything is shown. */
  loadMore(): void {
    const r = this.rows;
    if (!r.hasMore || r.loading || r.loadingMore || r.error) return;
    this.go({ show: Math.max(this.current.show, r.items.length) + this.spec.pageSize });
  }

  retry(): Promise<void> {
    return this.controller.retry();
  }

  open(id: string, panel: PanelMode = { kind: 'view' }): void {
    this.go({ id, panel });
  }

  setPanel(panel: PanelMode): void {
    if (this.current.id) this.go({ panel });
  }

  close(): void {
    this.go({ id: undefined, panel: { kind: 'view' } });
  }

  openCreate(presets: Record<string, string> = {}): void {
    this.go({ create: 'new', createStep: 0, presets });
  }

  setCreateStep(step: number): void {
    this.go({ createStep: step });
  }

  closeCreate(): void {
    this.go({ create: undefined });
  }

  /** Opens the import stepper at its upload step. */
  openImport(): void {
    this.go({ import: 'new', importStep: 0 });
  }

  /** Shows a step of an uploaded import; `replace` when the import itself moved on (it ran, or finished). */
  setImport(id: string, step: number, replace = false): void {
    this.go({ import: id, importStep: step }, replace);
  }

  closeImport(): void {
    this.go({ import: undefined });
  }

  /** After creating, show the new record in place of the create form. */
  showCreated(id: string): void {
    this.go({ id, panel: { kind: 'view' } }, true);
  }
}
