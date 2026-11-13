import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, type ParamMap } from '@angular/router';
import type { ListLayout, RecordView, RuntimeAction } from '../core/models';
import type { Viewer } from '../core/records/record/forms';
import { httpGateway } from '../core/records/gateway/http-gateway';
import { listLayout, preferredLayout, rememberLayout } from '../core/records/list/layout';
import type { ListSnapshot } from '../core/records/list/list-controller';
import { ListSession } from '../core/records/list/list-session';
import { hasRowActions, openTarget } from '../core/records/record/actions';
import { transferMenu } from '../core/records/import/import-session';
import { filterPills } from '../core/records/record/present';
import { panelRow, rowIntent, tableColumns } from '../core/records/list/rows';
import { canCreateOn, type ListSpec } from '../core/records/spec';
import { parseListUrl, type ListState } from '../core/records/list/url';
import { httpPages } from '../core/http/http-pages';
import { t } from '../core/i18n/i18n';
import { pinEntries, pinList } from '../core/pages';
import { Api, ApiError } from '../services/api';
import type { Notice } from './notice';
import { Session } from '../services/session';
import { Viewport } from '../ui/viewport';
import { DebouncedSearch } from './search';

const EMPTY: ListSnapshot = { items: [], total: 0, loading: true, loadingMore: false, hasMore: false, error: '' };

/**
 * Angular wrapper around one list session: reads the address bar, exposes the
 * list as signals, and writes every intent back to the address bar. It is the
 * only place list state reaches the router.
 */
@Injectable()
export class ListStore {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(Session);
  private params: ParamMap | null = null;
  private detach: (() => void)[] = [];

  readonly gateway = httpGateway(inject(Api));
  readonly spec = signal<ListSpec | null>(null);
  readonly state = signal<ListState | null>(null);
  readonly rows = signal<ListSnapshot>(EMPTY);
  /** The record open right now, highlighted in either layout; no row is shaded once it closes. */
  readonly lastOpened = signal<string | null>(null);

  readonly viewer = computed<Viewer>(() => {
    const me = this.session.me();
    return { id: me?.userId ?? '', roles: me?.roles ?? [] };
  });
  readonly narrow = inject(Viewport).narrow;
  private readonly wide = inject(Viewport).wide;
  readonly view = computed<ListLayout>(() => {
    const spec = this.spec();
    const state = this.state();
    if (!spec || !state) return 'cards';
    return listLayout(this.narrow(), state.view, () => preferredLayout(this.tenant(), spec.type.key, spec.layout));
  });
  readonly columns = computed(() => {
    const spec = this.spec();
    return spec ? tableColumns(spec, this.wide()) : [];
  });
  /** Entries of the list's ⋮ menu: pins, then import and export with their permissions (Select comes from the bulk store). */
  readonly listMenu = computed<{ id: string; label: string }[]>(() => {
    const spec = this.spec();
    if (!spec) return [];
    const pins = pinEntries(!!this.session.me()?.capabilities.publish, this.listViewKey(spec));
    return [...pins, ...transferMenu(this.session.me()?.permissions ?? [], spec.type.key)];
  });
  readonly pinNotice = signal<Notice | null>(null);
  private readonly pages = httpPages(inject(Api));
  /** The rows as both layouts draw them, each with its row menu. */
  readonly rowViews = computed(() => {
    const spec = this.spec();
    const chip = this.state()?.chip;
    const viewer = this.viewer();
    return spec ? this.rows().items.map((r) => panelRow(spec, r, viewer, chip)) : [];
  });
  readonly pills = computed(() => {
    const spec = this.spec();
    const state = this.state();
    return spec && state ? filterPills(spec.filters, state.criteria) : [];
  });

  /** Search text as typed; both layouts bind their search box to it. */
  readonly search = new DebouncedSearch(() => this.intents);
  readonly canCreate = computed(() => {
    const spec = this.spec();
    const state = this.state();
    return !!spec && !!state && canCreateOn(spec, state.chip);
  });
  readonly hasRowActions = computed(() => !!this.spec() && hasRowActions(this.spec()!));

  private list: ListSession | null = null;

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      this.params = p;
      void this.list?.fromUrl((n) => p.get(n));
    });
    effect(() => this.search.sync(this.state()?.q ?? ''));
    inject(DestroyRef).onDestroy(() => {
      this.detach.forEach((d) => d());
      this.search.dispose();
    });
  }

  /** Runs an action that needs no panel on a listed record; the record store fills this in. */
  runAction: (record: RecordView, action: RuntimeAction) => void = () => undefined;

  /** Exports the list as it is shown; the import store fills this in. */
  exportList: () => void = () => undefined;

  /** Runs an entry of the list's ⋮ menu. */
  chooseMenu(entry: string): void {
    if (entry === 'import') this.intents.openImport();
    else if (entry === 'export') this.exportList();
    else if (entry === 'pin' || entry === 'pinAll') void this.pin(entry === 'pinAll');
  }

  /** Pins the list as shown to the person's Home, or into the Home page draft for everyone. */
  private async pin(everyone: boolean): Promise<void> {
    const spec = this.spec();
    const state = this.state();
    if (!spec || !state) return;
    try {
      this.pinNotice.set({ level: 'success', message: await pinList(this.pages, spec, state, this.listViewKey(spec), everyone) });
    } catch (e) {
      this.pinNotice.set({ level: 'error', message: e instanceof ApiError ? e.message : t('ui.pins.failed') });
    }
  }

  private listViewKey(spec: ListSpec): string | undefined {
    return this.session.defs()?.listViews?.[spec.type.key]?.key;
  }

  /** Runs a row menu entry, the same in both layouts: it opens the record in that panel, or runs the action at once. */
  runRowAction(id: string, entry: string): void {
    const spec = this.spec();
    const intent = spec ? rowIntent(spec, entry) : null;
    if (!intent) return;
    if ('panel' in intent) this.intents.open(id, intent.panel);
    else {
      const record = this.rows().items.find((r) => r.id === id);
      if (record) this.runAction(record, intent.run);
    }
  }

  /** Goes where an action asked: a screen of the app such as the print view, or a link the device handles (UPI, a payment page). */
  async follow(open: string): Promise<void> {
    const target = openTarget(open);
    if (!target) return;
    if (target.kind === 'external') {
      window.location.assign(target.url);
      return;
    }
    // Back from the print view returns to the record, not to the action's form.
    if (this.state()?.panel.kind !== 'view') {
      await this.router.navigate([], { relativeTo: this.route, queryParams: { panel: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }
    await this.router.navigateByUrl(target.url);
  }

  /** Opens a receipt's print view. */
  printReceipt(receiptId: string): void {
    void this.router.navigate(['/print/receipt', receiptId]);
  }

  /** Goes to another record type's list, e.g. a related record (`id`) or creating one for this record (`create` with presets). */
  openList(type: string, queryParams: Record<string, string>): void {
    void this.router.navigate(['/records', type], { queryParams });
  }

  /** The list session; every intent of both layouts goes through it. */
  get intents(): ListSession {
    return this.list!;
  }

  use(spec: ListSpec): void {
    this.detach.forEach((d) => d());
    this.spec.set(spec);
    this.rows.set(EMPTY);
    this.lastOpened.set(null);
    const list = new ListSession(
      spec,
      this.gateway,
      {
        navigate: (queryParams, replaceUrl) =>
          void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl }),
      },
      {
        preferred: () => preferredLayout(this.tenant(), spec.type.key, spec.layout),
        remember: (layout) => rememberLayout(this.tenant(), spec.type.key, layout),
      },
    );
    this.list = list;
    this.detach = [
      list.controller.subscribe((s) => this.rows.set(s)),
      list.onState((s) => {
        this.state.set(s);
        this.lastOpened.set(s.id || null);
      }),
    ];
    const p = this.params;
    this.state.set(parseListUrl((n) => p?.get(n) ?? null, spec));
    void list.fromUrl((n) => p?.get(n) ?? null);
  }

  private tenant(): string {
    return this.session.me()?.tenant.key ?? '';
  }
}
