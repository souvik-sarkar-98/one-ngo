import { Component, DestroyRef, HostListener, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { initials, Nav, PageFrame, type Crumb, type NavItem } from '@onengo/web-kit';
import { filter } from 'rxjs';
import { OperatorApi } from './services/operator-api';

@Component({
  selector: 'op-root',
  standalone: true,
  imports: [Nav, PageFrame, RouterLink, RouterOutlet],
  template: `<div class="console">
    <header class="appbar">
      <strong class="brand">NGOOne</strong>
      <span class="slot">Operator console</span>
      <span class="sp"></span>
      @if (api.session()?.authenticated) {
        <span class="avatar" [attr.title]="api.session()?.display">{{ mark() }}</span>
      }
    </header>
    @if (api.session()?.authenticated && crumbs().length) {
      <nav class="crumbs" aria-label="Breadcrumb">
        <ol>
          @for (crumb of crumbs(); track crumb.label) {
            <li [attr.aria-current]="crumb.href ? null : 'page'">
              @if (crumb.href) { <a [routerLink]="crumb.href">{{ crumb.label }}</a> } @else { {{ crumb.label }} }
            </li>
          }
        </ol>
      </nav>
    }
    <div class="frame">
      @if (api.session()?.authenticated && destinations().length) {
        <aside class="rail-slot">
          <app-nav [items]="destinations()" [active]="active()" position="rail" label="Console" (navigate)="go($event)" (command)="command($event)" />
        </aside>
      }
      <main>
        <app-page-frame><router-outlet /></app-page-frame>
      </main>
    </div>
    @if (api.session()?.authenticated && destinations().length) {
      <div class="bottom-slot">
        <app-nav [items]="destinations()" [active]="active()" position="bottom" label="Console" (navigate)="go($event)" (command)="command($event)" />
      </div>
    }
    @if (confirmSignOut()) {
      <div class="signout" role="presentation">
        <div class="signout__card" role="alertdialog" aria-labelledby="signout-title" aria-describedby="signout-text">
          <h2 id="signout-title">Sign out?</h2>
          <p id="signout-text">You will be signed out on this device and will need to sign in again.</p>
          <div class="signout__acts">
            <button type="button" class="ghost" (click)="cancelSignOut()">Cancel</button>
            <button type="button" class="danger" [disabled]="signingOut()" (click)="signOut()">Sign out</button>
          </div>
        </div>
      </div>
    }
  </div>`,
})
export class App {
  readonly api = inject(OperatorApi);
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
