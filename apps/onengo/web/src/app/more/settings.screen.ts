import { Component, computed, inject, signal } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { beginInstall, installOffer, installState } from '../pwa/install';
import { InstallSteps } from '../pwa/install-steps';
import { TranslatePipe } from '../services/i18n';
import { MobileFormSheet } from '../ui/form-panel';
import { ScreenHeading } from '../ui/screen-heading';
import { MoreStore } from './more-store';
import { PasskeyManager } from './passkey-manager';

/** Settings: a read-only profile, language, two-step status and About. The user guide is a navigation destination. */
@Component({
  selector: 'app-settings',
  imports: [TranslatePipe, MobileFormSheet, ScreenHeading, PageFrame, PasskeyManager, InstallSteps],
  providers: [MoreStore],
  styles: `
    :host {
      display: block;
    }
    .settings__group {
      margin-bottom: 14px;
    }
    .settings__heading {
      margin: 16px 2px 6px;
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .settings__card {
      background: var(--card);
      border: 1px solid rgba(148, 163, 184, 0.22);
      border-radius: 16px;
      padding: 14px;
    }
    .settings__who {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .settings__id {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      min-width: 0;
    }
    .settings__roles {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .settings__role {
      background: var(--badge-bg);
      color: var(--badge-fg);
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 0.7rem;
      font-weight: 700;
      line-height: 1.2;
    }
    .settings__avatar {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--brand) 12%, #fff);
      color: var(--brand);
      font-weight: 700;
    }
    .settings__who strong {
      font-size: 1rem;
    }
    .settings__facts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: 24px;
      margin: 12px 0 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .settings__facts > div {
      display: grid;
      grid-template-columns: minmax(96px, 36%) 1fr;
      gap: 8px;
      min-width: 0;
      padding: 8px 0;
      font-size: 0.85rem;
    }
    @media (max-width: 759.98px) {
      .settings__facts {
        grid-template-columns: 1fr;
      }
      .settings__facts > div + div {
        border-top: 1px solid var(--line);
      }
    }
    .settings__facts dt {
      color: var(--muted);
    }
    .settings__facts dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .settings__note {
      margin: 8px 0 0;
      font-size: 0.8rem;
    }
    .settings__list {
      margin: 0;
      padding: 0;
      list-style: none;
      background: var(--card);
      border: 1px solid rgba(148, 163, 184, 0.22);
      border-radius: 16px;
      overflow: hidden;
    }
    .settings__row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 48px;
      padding: 10px 14px;
      box-sizing: border-box;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: start;
      text-decoration: none;
    }
    .settings__list li + li .settings__row {
      border-top: 1px solid var(--line);
    }
    button.settings__row,
    a.settings__row {
      cursor: pointer;
    }
    button.settings__row:hover,
    a.settings__row:hover {
      background: color-mix(in srgb, var(--brand) 5%, #fff);
    }
    .settings__row--static {
      cursor: default;
    }
    .settings__label {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }
    .settings__chev {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 44px;
      height: 44px;
      color: #94a3b8;
      font-size: 1.1rem;
    }
    .settings__lead {
      margin: 0 0 10px;
      font-size: 0.85rem;
    }
    .settings__languages {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .settings__language {
      min-height: 52px;
    }
    .settings__language[aria-pressed='true'] {
      background: color-mix(in srgb, var(--brand) 6%, #fff);
    }
    .settings__selected {
      margin-inline-start: auto;
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--brand);
    }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.nav.settings' | t" />
      @let m = store.model();

      <section class="settings__group" aria-labelledby="settings-profile">
        <h2 id="settings-profile" class="settings__heading">{{ 'ui.crumbs.myProfile' | t }}</h2>
        <div class="settings__card">
          <div class="settings__who">
            <span class="settings__avatar" aria-hidden="true">{{ m.account.initials }}</span>
            <div class="settings__id">
              <strong>{{ m.account.name }}</strong>
              @if (store.roleNames().length) {
                <ul class="settings__roles" [attr.aria-label]="'ui.settings.roles' | t">
                  @for (role of store.roleNames(); track role) {
                    <li class="settings__role">{{ role }}</li>
                  }
                </ul>
              }
            </div>
          </div>
          <dl class="settings__facts">
            <div>
              <dt>{{ 'ui.settings.email' | t }}</dt>
              <dd>{{ store.email() }}</dd>
            </div>
            <div>
              <dt>{{ 'ui.more.organisation' | t }}</dt>
              <dd>{{ store.organisation() }}</dd>
            </div>
          </dl>
          <p class="muted settings__note">{{ 'ui.profile.accountHint' | t }}</p>
        </div>
      </section>

      <section class="settings__group" aria-labelledby="settings-preferences">
        <h2 id="settings-preferences" class="settings__heading">{{ 'ui.settings.preferences' | t }}</h2>
        <ul class="settings__list">
          <li>
            <button type="button" class="settings__row" (click)="store.openPanel('language')">
              <span class="settings__label">
                <strong>{{ 'ui.crumbs.language' | t }}</strong>
                <span class="muted">{{ store.languageName() }}</span>
              </span>
              <span class="settings__chev" aria-hidden="true">›</span>
            </button>
          </li>
          <li>
            <div class="settings__row settings__row--static">
              <span class="settings__label">
                <strong>{{ 'ui.more.twoStep' | t }}</strong>
                <span class="muted">{{ (m.twoStep ? 'ui.settings.twoStepOn' : 'ui.settings.twoStepOff') | t }}</span>
              </span>
              <span class="badge" [class.ok]="m.twoStep">{{ (m.twoStep ? 'ui.more.on' : 'ui.more.off') | t }}</span>
            </div>
          </li>
        </ul>
      </section>

      <app-passkey-manager [twoStep]="m.twoStep" />

      <section class="settings__group" aria-labelledby="settings-help">
        <h2 id="settings-help" class="settings__heading">{{ 'ui.settings.help' | t }}</h2>
        <ul class="settings__list">
          @if (showInstall()) {
            <li>
              <button type="button" class="settings__row" (click)="install()">
                <span class="settings__label">
                  <strong>{{ 'ui.pwa.install' | t }}</strong>
                  <span class="muted">{{ 'ui.pwa.installHint' | t }}</span>
                </span>
                <span class="settings__chev" aria-hidden="true">›</span>
              </button>
            </li>
          }
          <li>
            <button type="button" class="settings__row" (click)="store.openPanel('about')">
              <span class="settings__label">
                <strong>{{ 'ui.more.about' | t }}</strong>
                <span class="muted">{{ 'ui.settings.version' | t: store.about }}</span>
              </span>
              <span class="settings__chev" aria-hidden="true">›</span>
            </button>
          </li>
        </ul>
      </section>

      @if (store.panel() === 'language') {
        <app-mobile-form-sheet [open]="true" [title]="'ui.crumbs.language' | t" [showDefaultFooter]="false" (dismissed)="store.closePanel()">
          <p class="muted settings__lead">{{ 'ui.settings.languageHint' | t }}</p>
          @if (store.languageError()) {
            <div class="notice error" role="alert">{{ store.languageError() }}</div>
          }
          <ul class="settings__languages">
            @for (l of store.languages; track l.code) {
              <li>
                <button
                  type="button"
                  class="settings__row settings__language"
                  [attr.lang]="l.code"
                  [attr.aria-pressed]="l.code === store.locale()"
                  [disabled]="store.changingLanguage()"
                  (click)="store.chooseLanguage(l.code)">
                  <span class="settings__label"><strong>{{ l.name }}</strong></span>
                  @if (l.code === store.locale()) {
                    <span class="settings__selected">{{ 'ui.settings.selected' | t }}</span>
                  }
                </button>
              </li>
            }
          </ul>
        </app-mobile-form-sheet>
      }

      @if (help(); as offer) {
        <app-mobile-form-sheet [open]="true" [title]="'ui.pwa.install' | t" [showDefaultFooter]="false" (dismissed)="help.set(null)">
          <app-install-steps [offer]="offer" />
        </app-mobile-form-sheet>
      }

      @if (store.panel() === 'about') {
        <app-mobile-form-sheet [open]="true" [title]="'ui.more.about' | t" [showDefaultFooter]="false" (dismissed)="store.closePanel()">
          <p class="settings__lead">{{ 'ui.more.aboutDetail' | t: store.about }}</p>
          <dl class="settings__facts">
            <div>
              <dt>{{ 'ui.more.organisation' | t }}</dt>
              <dd>{{ store.organisation() }}</dd>
            </div>
          </dl>
        </app-mobile-form-sheet>
      }
    </app-page-frame>
  `,
})
export class SettingsScreen {
  readonly store = inject(MoreStore);
  readonly help = signal<'ios' | 'browser' | null>(null);
  readonly showInstall = computed(() => this.store.canInstall() && installOffer(installState()) !== 'installed');

  async install(): Promise<void> {
    this.help.set(await beginInstall());
  }
}
