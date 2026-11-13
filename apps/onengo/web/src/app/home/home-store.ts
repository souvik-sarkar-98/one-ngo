import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { httpPages } from '../core/http/http-pages';
import { t } from '../core/i18n/i18n';
import {
  HOME_PAGE,
  compactNumber,
  emptyContent,
  loadWidget,
  movedPins,
  pinMenu,
  planPage,
  type Pin,
  type PlannedWidget,
  type WidgetContent,
} from '../core/pages';
import { httpGateway } from '../core/records/gateway/http-gateway';
import type { RowView } from '../core/rows';
import { Api, ApiError } from '../services/api';
import { I18n } from '../services/i18n';
import { Session } from '../services/session';
import { Viewport } from '../ui/viewport';

interface Loaded {
  sig: string;
  loading: boolean;
  error: boolean;
  content: WidgetContent | null;
}

const signature = (w: PlannedWidget) =>
  w.kind === 'list' ? JSON.stringify([w.spec.type.key, w.query]) : w.kind === 'stat' || w.kind === 'chart' ? JSON.stringify([w.recordType, w.request]) : '';

/**
 * Home, or a page from More: the page's widgets for the person, their pins
 * first on Home, each loaded on its own. The only place these screens reach
 * the router and the gateways.
 */
@Injectable()
export class HomeStore {
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private readonly i18n = inject(I18n);
  private readonly pages = httpPages(inject(Api));
  private readonly records = httpGateway(inject(Api));

  private readonly route = inject(ActivatedRoute);
  /** The page from the address (`/pages/:key`); Home at `/`. */
  readonly key = toSignal(this.route.paramMap.pipe(map((p) => p.get('key') || HOME_PAGE)), {
    initialValue: this.route.snapshot.paramMap.get('key') || HOME_PAGE,
  });
  readonly pins = signal<Pin[]>([]);
  readonly narrow = inject(Viewport).narrow;
  readonly isHome = computed(() => this.key() === HOME_PAGE);
  /** Set when a route the person cannot open sent them here. */
  readonly denied = toSignal(this.route.queryParamMap.pipe(map((p) => p.has('denied'))), {
    initialValue: this.route.snapshot.queryParamMap.has('denied'),
  });
  readonly plan = computed(() => planPage(this.session.defs(), this.key(), this.session.me()?.roles ?? [], this.isHome() ? this.pins() : []));
  readonly welcome = computed(() => {
    this.i18n.locale();
    return t('ui.home.welcome', { name: this.session.me()?.displayName ?? '' });
  });
  /** Home, or the name of a page opened from More. */
  readonly heading = computed(() => {
    this.i18n.locale();
    if (this.isHome()) return t('ui.nav.home');
    const key = this.key();
    return this.session.defs()?.pages?.find((p) => p.key === key)?.label ?? '';
  });
  readonly noRecords = computed(() => !this.session.defs()?.recordTypes.length);
  private readonly updatedAt = signal<Date | null>(null);
  /** When the figures were last loaded, on pages from More. */
  readonly updated = computed(() => {
    const at = this.updatedAt();
    return at ? t('ui.pages.updated', { time: at.toLocaleTimeString(this.i18n.locale(), { hour: '2-digit', minute: '2-digit' }) }) : '';
  });
  readonly notice = signal('');
  /** The pin being renamed, with the name as typed. */
  readonly renaming = signal<{ id: string; label: string } | null>(null);
  readonly saving = signal(false);

  private readonly loaded = signal<Record<string, Loaded>>({});

  readonly widgets = computed(() => {
    this.i18n.locale();
    const defs = this.session.defs();
    const loaded = this.loaded();
    const pins = this.pins();
    return (this.plan()?.widgets ?? []).map((w) => {
      const state = loaded[w.id];
      const content = state?.content && 'label' in state.content && 'label' in w ? { ...state.content, label: w.label } : state?.content;
      const pin = w.kind === 'list' ? w.pin : undefined;
      return {
        id: w.id,
        model: content ?? emptyContent(w, defs),
        loading: !!state?.loading,
        error: !!state?.error,
        full: w.kind === 'groups',
        tag: pin ? t('ui.pins.yours') : '',
        menu: pin ? pinMenu(pins, pin.id) : [],
      };
    });
  });
  readonly format = compactNumber;

  constructor() {
    effect(() => {
      const plan = this.plan();
      if (plan) untracked(() => this.sync(plan.widgets));
    });
    effect(() => {
      if (this.isHome() && this.session.me()) untracked(() => void this.loadPins());
    });
  }

  open(link: string): void {
    void this.router.navigateByUrl(link);
  }

  /** Opens a row of a list widget in its list, with the same chip, filters and sort. */
  openRow(widgetId: string, row: RowView): void {
    const w = this.plan()?.widgets.find((x) => x.id === widgetId);
    if (w?.kind !== 'list') return;
    this.open(`${w.link}${w.link.includes('?') ? '&' : '?'}id=${encodeURIComponent(row.id)}`);
  }

  retry(widgetId: string): void {
    const w = this.plan()?.widgets.find((x) => x.id === widgetId);
    if (w) void this.load(w, signature(w));
  }

  async choosePinAction(widgetId: string, action: string): Promise<void> {
    const w = this.plan()?.widgets.find((x) => x.id === widgetId);
    const pin = w?.kind === 'list' ? w.pin : undefined;
    if (!w || w.kind !== 'list' || !pin) return;
    if (action === 'open') return this.open(w.link);
    if (action === 'rename') return this.renaming.set({ id: pin.id, label: pin.label });
    await this.changePins(async () => {
      if (action === 'unpin') {
        await this.pages.removePin(pin.id);
        return this.pins().filter((p) => p.id !== pin.id);
      }
      return this.pages.orderPins(movedPins(this.pins(), pin.id, action === 'up' ? -1 : 1));
    });
  }

  async saveRename(): Promise<void> {
    const r = this.renaming();
    if (!r) return;
    this.saving.set(true);
    const ok = await this.changePins(async () => {
      const renamed = await this.pages.renamePin(r.id, r.label);
      return this.pins().map((p) => (p.id === renamed.id ? renamed : p));
    });
    this.saving.set(false);
    if (ok) this.renaming.set(null);
  }

  private async changePins(change: () => Promise<Pin[]>): Promise<boolean> {
    this.notice.set('');
    try {
      this.pins.set(await change());
      return true;
    } catch (e) {
      this.notice.set(e instanceof ApiError ? e.message : t('ui.pins.changeFailed'));
      return false;
    }
  }

  private async loadPins(): Promise<void> {
    try {
      this.pins.set(await this.pages.pins());
    } catch {
      // Home still shows the organisation's widgets; pins return on the next visit.
    }
  }

  private sync(widgets: PlannedWidget[]): void {
    for (const w of widgets) {
      const sig = signature(w);
      if (sig && this.loaded()[w.id]?.sig !== sig) void this.load(w, sig);
    }
  }

  private async load(w: PlannedWidget, sig: string): Promise<void> {
    const set = (state: Loaded) => this.loaded.update((all) => (all[w.id] && all[w.id]!.sig !== sig && !state.loading ? all : { ...all, [w.id]: state }));
    set({ sig, loading: true, error: false, content: null });
    try {
      const content = await loadWidget(w, { pages: this.pages, records: this.records }, this.session.defs());
      set({ sig, loading: false, error: false, content });
    } catch {
      set({ sig, loading: false, error: true, content: null });
    }
    this.updatedAt.set(new Date());
  }
}
