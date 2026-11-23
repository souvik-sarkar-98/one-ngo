import { Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { AppBar, Breadcrumb, ConfirmDialog, initials, Nav, PageFrame, ShellFrame, Viewport, type Crumb, type NavItem } from '@onengo/web-kit';
import { filter } from 'rxjs';
import { OperatorApi } from './services/operator-api';

@Component({
  selector: 'op-root',
  standalone: true,
  imports: [AppBar, Breadcrumb, ConfirmDialog, Nav, PageFrame, RouterOutlet, ShellFrame],
  template: `<app-shell-frame [bottom]="viewport.narrow()">
    <app-bar shellBar product="NGOOne" context="Operator console" [initials]="mark()" [accountLabel]="api.session()?.display ?? 'Account'" />
    @if (api.session()?.authenticated && destinations().length && !viewport.narrow()) {
      <app-nav shellRail [items]="destinations()" [active]="active()" position="rail" label="Console" (navigate)="go($event)" (command)="command($event)" />
    }
    @if (api.session()?.authenticated && crumbs().length) {
      <app-breadcrumb shellAbove [crumbs]="crumbs()" [narrow]="viewport.narrow()" (navigate)="go($event)" />
    }
    <app-page-frame><router-outlet /></app-page-frame>
    @if (api.session()?.authenticated && destinations().length && viewport.narrow()) {
      <app-nav shellBottom [items]="destinations()" [active]="active()" position="bottom" label="Console" (navigate)="go($event)" (command)="command($event)" />
    }
    @if (confirmSignOut()) {
      <app-confirm-dialog
        shellOverlay
        title="Sign out?"
        text="You will be signed out on this device and will need to sign in again."
        confirmLabel="Sign out"
        [busy]="signingOut()"
        (confirm)="signOut()"
        (cancel)="cancelSignOut()" />
    }
  </app-shell-frame>`,
  styles: `:host { display: block; }`,
})
export class App {
  readonly api = inject(OperatorApi);
  readonly viewport = inject(Viewport);
  readonly confirmSignOut = signal(false);
  readonly signingOut = signal(false);
  readonly active = signal('organisations');
  readonly crumbs = signal<Crumb[]>([]);
  readonly mark = computed(() => initials(this.api.session()?.display ?? ''));
  readonly destinations = computed<NavItem[]>(() => {
    const items: NavItem[] = [];
    if (this.api.can('status')) {
      items.push({ key: 'organisations', label: 'Organisations', icon: 'search', link: '/organisations' });
    }
    if (this.api.can('onboard')) items.push({ key: 'onboard', label: 'Onboard', icon: 'add', link: '/organisations/onboard' });
    if (this.api.can('operators')) items.push({ key: 'operators', label: 'Operators', icon: 'people', link: '/operators' });
    if (this.api.can('audit')) items.push({ key: 'activity', label: 'Activity', icon: 'records', link: '/activity' });
    if (this.api.session()?.authenticated) items.push({ key: 'signout', label: 'Sign out', icon: 'logout', link: '', command: 'sign-out' });
    return items;
  });
  private readonly router = inject(Router);

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.follow(this.router.url);
    this.router.events.pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd), takeUntilDestroyed(destroyRef))
      .subscribe((event) => this.follow(event.urlAfterRedirects));
  }

  go(link: string): void {
    void this.router.navigateByUrl(link);
  }

  command(name: string): void {
    if (name === 'sign-out') this.confirmSignOut.set(true);
  }

  @HostListener('document:keydown.escape')
  cancelSignOut(): void {
    if (!this.signingOut()) this.confirmSignOut.set(false);
  }

  async signOut(): Promise<void> {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    try {
      await this.api.logout();
    } catch {
      this.signingOut.set(false);
    }
  }

  private follow(url: string): void {
    const path = url.split('?')[0] ?? '';
    this.active.set(this.activeFor(path));
    this.crumbs.set(this.crumbsFor(path));
  }

  private activeFor(path: string): string {
    if (path.includes('/onboard')) return 'onboard';
    if (path.startsWith('/operators')) return 'operators';
    if (path.startsWith('/activity')) return 'activity';
    return 'organisations';
  }

  private crumbsFor(path: string): Crumb[] {
    if (path.startsWith('/organisations/status') || path.startsWith('/organisations/sign-in')) {
      return [{ label: 'Organisations', href: '/organisations' }, { label: path.includes('sign-in') ? 'Sign-in' : 'Organisation' }];
    }
    if (path.startsWith('/organisations/onboard')) return [{ label: 'Onboard' }];
    if (path.startsWith('/organisations')) return [{ label: 'Organisations' }];
    if (/^\/operators\/.+/.test(path)) return [{ label: 'Operators', href: '/operators' }, { label: 'Operator' }];
    if (path.startsWith('/operators')) return [{ label: 'Operators' }];
    if (path.startsWith('/activity')) return [{ label: 'Activity' }];
    return [];
  }
}
