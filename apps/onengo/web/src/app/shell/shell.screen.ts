import { Component, HostListener, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { OfflineBanner } from '../pwa/offline-banner';
import { UpdatePrompt } from '../pwa/update-prompt';
import { TranslatePipe } from '../services/i18n';
import { MoreTray } from './more-tray';
import { AppBar } from '../ui/app-bar';
import { Breadcrumb } from '../ui/breadcrumb';
import { DialogFocus } from '../ui/dialog';
import { MobileFormSheet } from '../ui/form-panel';
import { Nav } from '@onengo/web-kit';
import { ShellStore } from './shell-store';

/** App bar, the one breadcrumb, and the destinations as a rail or a bottom bar around every signed-in screen. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, AppBar, Breadcrumb, Nav, OfflineBanner, UpdatePrompt, TranslatePipe, MoreTray, MobileFormSheet, DialogFocus],
  providers: [ShellStore],
  styles: `
    :host {
      display: block;
      min-height: 100vh;
    }
    .shell__bar {
      position: sticky;
      top: 0;
      z-index: 30;
    }
    .shell__body {
      display: flex;
      min-height: calc(100vh - 56px);
    }
    .shell__rail {
      position: sticky;
      top: 56px;
      flex: 0 0 auto;
      height: calc(100vh - 56px);
    }
    .shell__main {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    .shell__content {
      width: 100%;
      padding: 1.25rem;
      box-sizing: border-box;
    }
    .shell--bottom .shell__content {
      padding: 0.75rem 0.75rem calc(70px + env(safe-area-inset-bottom, 0px));
    }
    .shell__bottom {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 30;
    }
    .signout {
      position: fixed;
      inset: 0;
      z-index: 400;
      display: grid;
      place-items: center;
      padding: 24px;
      background: rgba(15, 23, 42, 0.45);
    }
    .signout__card {
      width: min(420px, 100%);
      padding: 20px 20px 16px;
      border: 1px solid #e8c56a;
      border-radius: 14px;
      background: var(--card, #fff);
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.24);
    }
    .signout__card h2 {
      margin: 0 0 8px;
      color: var(--warn, #9a6200);
      font-size: 1.05rem;
    }
    .signout__card p {
      margin: 0 0 16px;
    }
    .signout__acts {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .signout__go {
      background: var(--bad, #b91c1c);
      border-color: var(--bad, #b91c1c);
      color: #fff;
    }
  `,
  template: `
    <div class="shell" [class.shell--bottom]="store.navPosition() === 'bottom'">
      <app-bar
        class="shell__bar"
        [organisation]="store.organisation()"
        [logo]="store.logo()"
        [inboxCount]="store.badge()"
        [initials]="store.initials()"
        [labels]="{ inbox: 'ui.nav.inbox' | t, account: 'ui.nav.account' | t }"
        (navigate)="store.go($event)" />
      <div class="shell__body">
        @if (store.navPosition() === 'rail') {
          <app-nav class="shell__rail" position="rail" [items]="store.destinations()" [active]="store.active()" [menuOpen]="store.moreOpen()" [label]="'ui.nav.main' | t" (navigate)="store.go($event)" (menu)="store.toggleMore()" (command)="store.command($event)" />
        }
        <div class="shell__main">
          <app-offline-banner />
          <app-breadcrumb
            [crumbs]="store.crumbs()"
            [narrow]="store.narrow()"
            [labels]="{ nav: 'ui.crumbs.nav' | t, showTrail: 'ui.crumbs.showTrail' | t }"
            (navigate)="store.go($event)" />
          <main class="shell__content page">
            <router-outlet />
          </main>
        </div>
      </div>
      @if (store.navPosition() === 'bottom') {
        <app-nav class="shell__bottom" position="bottom" [items]="store.destinations()" [active]="store.active()" [menuOpen]="store.moreOpen()" [label]="'ui.nav.main' | t" (navigate)="store.go($event)" (menu)="store.toggleMore()" (command)="store.command($event)" />
      }
      @if (store.moreOpen()) {
        <app-mobile-form-sheet [open]="true" [title]="'ui.nav.more' | t" [showDefaultFooter]="false" (dismissed)="store.closeMore()">
          <app-more-tray [items]="store.moreTiles()" (open)="store.go($event)" (command)="store.command($event)" />
        </app-mobile-form-sheet>
      }
      <app-update-prompt />
      @if (store.confirmSignOut()) {
        <div class="signout" data-dialog-shade role="presentation">
          <div
            class="signout__card"
            appDialog
            role="alertdialog"
            aria-labelledby="signout-title"
            aria-describedby="signout-text"
            (escape)="store.cancelSignOut()">
            <h2 id="signout-title">{{ 'ui.shell.signOutTitle' | t }}</h2>
            <p id="signout-text">{{ 'ui.shell.signOutWarning' | t }}</p>
            <div class="signout__acts">
              <button type="button" class="app-btn" (click)="store.cancelSignOut()">{{ 'ui.common.cancel' | t }}</button>
              <button type="button" class="app-btn signout__go" [disabled]="store.signingOut()" (click)="store.signOut()">{{ 'ui.shell.signOut' | t }}</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class ShellScreen {
  readonly store = inject(ShellStore);

  @HostListener('document:keydown.escape')
  closeMore(): void {
    this.store.closeMore();
  }
}
