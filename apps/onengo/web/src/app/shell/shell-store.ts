import { Location } from '@angular/common';
import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { NavigationEnd, Router } from '@angular/router';
import { trail } from '../core/shell/breadcrumbs';
import { changesApprovals, httpShell } from '../core/http/http-shell';
import { browserTitle } from '../core/organisation/organisation';
import { organisationCode } from '../core/organisation/sign-in';
import { pointAppleTouchIcon } from '../pwa/install';
import { languageName } from '../core/i18n/languages';
import { ApprovalsBadge, PHONE_SLOTS, activeNavItem, appTitle, initials, isTopLevel, navFor, navigationLayout, organisationLogo, railCapacity, shellRoute, signOutOnPhone } from '../core/shell/shell';
import { applyTheme } from '../core/theme';
import { Api } from '../services/api';
import { I18n } from '../services/i18n';
import { Organisation } from '../services/organisation';
import { ScreenMeta } from '../services/screen-meta';
import { Session } from '../services/session';
import { Viewport } from '../ui/viewport';

/**
 * The shell's state: destinations with the approvals badge, the active one,
 * the app bar and the breadcrumb, all derived from the address. The only place
 * the shell reaches the router.
 */
@Injectable()
export class ShellStore {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly session = inject(Session);
  private readonly meta = inject(ScreenMeta);
  private readonly i18n = inject(I18n);
  private readonly brand = inject(Organisation);
  private readonly approvals = new ApprovalsBadge(httpShell(inject(Api)), () => document.visibilityState !== 'hidden');

  readonly route = signal(shellRoute(this.router.url));
  readonly badge = signal(0);
  readonly narrow = inject(Viewport).narrow;
  readonly navPosition = computed(() => (this.narrow() ? 'bottom' : 'rail'));
  readonly viewportHeight = signal(typeof window === 'undefined' ? 0 : window.innerHeight);
  readonly moreOpen = signal(false);
  private readonly layout = computed(() => {
    this.i18n.locale();
    return navigationLayout(this.session.me(), this.session.defs(), this.badge());
  });
  /** Phone keeps four slots. The rail keeps as many standard-size icons as the window height allows. */
  private readonly capacity = computed(() => (this.navPosition() === 'bottom' ? PHONE_SLOTS : railCapacity(this.viewportHeight())));
  private readonly placed = computed(() => {
    const placed = navFor(this.layout(), this.capacity());
    return this.navPosition() === 'bottom' ? signOutOnPhone(placed) : placed;
  });
  readonly destinations = computed(() => this.placed().items);
  readonly moreTiles = computed(() => this.placed().more);
  readonly languageLabel = computed(() => languageName(this.i18n.locale()));
  readonly active = computed(() => (this.moreOpen() ? 'more' : activeNavItem(this.route().path, this.destinations(), this.moreTiles())));
  readonly crumbs = computed(() => {
    this.i18n.locale();
    const { path, params } = this.route();
    return trail(path, params, this.session.defs(), { last: this.meta.crumbLabel(), named: this.meta.crumbLabels() });
  });
  /** The NGO's display name and logo beside the OneNGO mark; the name signed in with until the organisation's own loads. */
  readonly organisation = computed(() => this.brand.branding()?.displayName ?? this.session.me()?.tenant.name ?? '');
  readonly logo = computed(() => this.brand.logo() ?? organisationLogo(this.session.me()?.tenant.logo));
  /** `<screen or NGO> | OneNGO`. */
  readonly title = computed(() => {
    this.i18n.locale();
    const route = this.route();
    return browserTitle(route.path === '' ? this.organisation() : appTitle(route, this.session.defs(), this.session.me()));
  });
  readonly showBack = computed(() => !isTopLevel(this.route().path));
  readonly initials = computed(() => initials(this.session.me()?.displayName));
  readonly confirmSignOut = signal(false);
  readonly signingOut = signal(false);

  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((e) => {
      if (!(e instanceof NavigationEnd)) return;
      this.route.set(shellRoute(e.urlAfterRedirects));
      this.moreOpen.set(false);
      void this.approvals.refresh();
    });
    const unsubscribe = this.approvals.subscribe((n) => this.badge.set(n));
    this.approvals.start((ms, run) => {
      const id = setInterval(run, ms);
      return () => clearInterval(id);
    });
    const offWrite = inject(Api).onWrite((method, url) => {
      if (changesApprovals(method, url)) void this.approvals.refresh();
    });
    effect((onCleanup) => {
      applyTheme(this.session.defs()?.theme ?? null);
      onCleanup(() => applyTheme(null));
    });
    const title = inject(Title);
    effect(() => title.setTitle(this.title()));
    effect(() => {
      const code = organisationCode(this.session.me()?.tenant.key);
      pointAppleTouchIcon(code && this.logo() ? `/api/auth/organisations/${code}/icon/180` : null);
    });
    effect(() => {
      if (this.moreTiles().length === 0) this.moreOpen.set(false);
    });
    const onResize = () => this.viewportHeight.set(window.innerHeight);
    window.addEventListener('resize', onResize);
    void this.brand.refresh();
    inject(DestroyRef).onDestroy(() => {
      unsubscribe();
      offWrite();
      window.removeEventListener('resize', onResize);
      this.approvals.stop();
    });
  }

  go(link: string): void {
    this.moreOpen.set(false);
    void this.router.navigateByUrl(link);
  }

  toggleMore(): void {
    this.moreOpen.update((open) => !open);
  }

  closeMore(): void {
    this.moreOpen.set(false);
  }

  command(name: string): void {
    this.moreOpen.set(false);
    if (name === 'sign-out') this.askSignOut();
  }

  askSignOut(): void {
    this.confirmSignOut.set(true);
  }

  cancelSignOut(): void {
    if (!this.signingOut()) this.confirmSignOut.set(false);
  }

  async signOut(): Promise<void> {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    try {
      await this.session.signOut();
      this.brand.clear();
      this.confirmSignOut.set(false);
      await this.router.navigateByUrl('/sign-in');
    } finally {
      this.signingOut.set(false);
    }
  }

  /** Back to the previous screen, or up the breadcrumb when the app was opened at this address. */
  back(): void {
    const previous = (history.state as { navigationId?: number } | null)?.navigationId ?? 1;
    if (previous > 1) return this.location.back();
    const up = this.crumbs()
      .slice(0, -1)
      .reverse()
      .find((c) => c.href);
    void this.router.navigateByUrl(up?.href ?? '/');
  }
}
