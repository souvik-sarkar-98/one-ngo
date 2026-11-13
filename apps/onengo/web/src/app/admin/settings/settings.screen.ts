import { Component, computed, inject, signal } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { Session } from '../../services/session';
import { CfForm } from '../../ui/cf-form';
import { ScreenHeading } from '../../ui/screen-heading';
import { SettingsStore } from './settings-store';

/**
 * Settings: the financial year, storage and the API limit. They are stored as organisation settings, and one Save
 * writes the changed ones. The sign-in methods are shown read-only; the platform operator sets them.
 */
@Component({
  selector: 'app-admin-settings',
  imports: [CfForm, ScreenHeading, TranslatePipe, PageFrame],
  providers: [SettingsStore],
  styleUrl: '../admin.css',
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.settings' | t" />
      <p class="muted">{{ 'ui.admin.settings.intro' | t }}</p>
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      @if (store.error()) {
        <div class="notice error" role="alert">{{ store.error() }}</div>
      }
      @if (store.loading()) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      } @else if (store.settings()) {
        <section class="card" aria-labelledby="org-limits-title">
          <h2 id="org-limits-title">{{ 'ui.admin.settings.limitsTitle' | t }}</h2>
          <cf-form [fields]="fields()" [values]="store.values()" [errors]="store.errors()" idPrefix="org-settings" [columns]="3" (valuesChange)="store.values.set($event)" />
          <div class="admin__line">
            <h3 id="org-storage-title">{{ 'ui.admin.settings.storage' | t }}</h3>
            <span class="admin__grow"></span>
            <span class="muted">{{ store.used() }}</span>
          </div>
          <div class="admin__bar" role="progressbar" aria-labelledby="org-storage-title" [attr.aria-valuetext]="store.used()" [attr.aria-valuenow]="store.percent()" aria-valuemin="0" aria-valuemax="100"><i [style.width.%]="store.percent()"></i></div>
          <div class="admin__line">
            <span class="admin__grow"></span>
            <button type="button" class="app-btn app-btn--primary" [disabled]="store.saving()" (click)="store.save('settings')">{{ (store.saving() ? 'ui.common.saving' : 'ui.common.save') | t }}</button>
          </div>
        </section>
        <section class="card" aria-labelledby="org-sign-in-title">
          <h2 id="org-sign-in-title">{{ 'ui.admin.settings.signIn' | t }}</h2>
          <p class="muted">{{ 'ui.admin.settings.signInIntro' | t }}</p>
          @if (providers(); as list) {
            @if (list.length) {
              <p>{{ 'ui.admin.settings.signInProviders' | t }}</p>
              <ul>
                @for (p of list; track p.id) { <li>{{ p.label }}</li> }
              </ul>
            } @else {
              <p>{{ 'ui.admin.settings.signInNone' | t }}</p>
            }
          }
        </section>
      }
    </app-page-frame>
  `,
})
export class SettingsScreen {
  readonly store = inject(SettingsStore);
  readonly fields = computed(() => [...this.store.finance(), ...this.store.storage(), ...this.store.api()]);
  private readonly session = inject(Session);
  /** The single sign-on providers the sign-in page offers. The operator sets them; this is read-only. */
  readonly providers = signal<{ id: string; label: string }[] | null>(null);

  constructor() {
    const key = this.session.me()?.tenant.key;
    if (key) void this.session.providers(key).then((list) => this.providers.set(list), () => this.providers.set([]));
  }
}
