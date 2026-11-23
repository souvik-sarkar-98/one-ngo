import { Component, HostListener, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppBar, Breadcrumb, ConfirmDialog, Nav, ShellFrame } from '@onengo/web-kit';
import { PRODUCT } from '../core/organisation/organisation';
import { OfflineBanner } from '../pwa/offline-banner';
import { UpdatePrompt } from '../pwa/update-prompt';
import { TranslatePipe } from '../services/i18n';
import { MobileFormSheet } from '../ui/form-panel';
import { MoreTray } from './more-tray';
import { ShellStore } from './shell-store';

/** App bar, the one breadcrumb, and the destinations as a rail or a bottom bar around every signed-in screen. The frame itself is the web kit's, shared with the operator console. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, AppBar, Breadcrumb, ConfirmDialog, Nav, ShellFrame, OfflineBanner, UpdatePrompt, TranslatePipe, MoreTray, MobileFormSheet],
  providers: [ShellStore],
  styles: `:host { display: block; }`,
  template: `
    <app-shell-frame [bottom]="store.navPosition() === 'bottom'">
      <app-bar
        shellBar
        [product]="product"
        [context]="store.organisation()"
        [logo]="store.logo()"
        inboxLink="/inbox"
        [inboxCount]="store.badge()"
        [inboxLabel]="'ui.nav.inbox' | t"
        [initials]="store.initials()"
        [accountLabel]="'ui.nav.account' | t"
        (navigate)="store.go($event)" />
      @if (store.navPosition() === 'rail') {
        <app-nav shellRail position="rail" [items]="store.destinations()" [active]="store.active()" [menuOpen]="store.moreOpen()" [label]="'ui.nav.main' | t" (navigate)="store.go($event)" (menu)="store.toggleMore()" (command)="store.command($event)" />
      }
      <app-offline-banner shellAbove />
      <app-breadcrumb
        shellAbove
        [crumbs]="store.crumbs()"
        [narrow]="store.narrow()"
        [labels]="{ nav: 'ui.crumbs.nav' | t, showTrail: 'ui.crumbs.showTrail' | t }"
        (navigate)="store.go($event)" />
      <router-outlet />
      @if (store.navPosition() === 'bottom') {
        <app-nav shellBottom position="bottom" [items]="store.destinations()" [active]="store.active()" [menuOpen]="store.moreOpen()" [label]="'ui.nav.main' | t" (navigate)="store.go($event)" (menu)="store.toggleMore()" (command)="store.command($event)" />
      }
      @if (store.moreOpen()) {
        <app-mobile-form-sheet shellOverlay [open]="true" [title]="'ui.nav.more' | t" [showDefaultFooter]="false" (dismissed)="store.closeMore()">
          <app-more-tray [items]="store.moreTiles()" (open)="store.go($event)" (command)="store.command($event)" />
        </app-mobile-form-sheet>
      }
      <app-update-prompt shellOverlay />
      @if (store.confirmSignOut()) {
        <app-confirm-dialog
          shellOverlay
          [title]="'ui.shell.signOutTitle' | t"
          [text]="'ui.shell.signOutWarning' | t"
          [confirmLabel]="'ui.shell.signOut' | t"
          [cancelLabel]="'ui.common.cancel' | t"
          [busy]="store.signingOut()"
          (confirm)="store.signOut()"
          (cancel)="store.cancelSignOut()" />
      }
    </app-shell-frame>
  `,
})
export class ShellScreen {
  readonly store = inject(ShellStore);
  readonly product = PRODUCT;

  @HostListener('document:keydown.escape')
  closeMore(): void {
    this.store.closeMore();
  }
}
