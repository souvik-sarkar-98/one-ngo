import { Component, inject, signal } from '@angular/core';
import { Btn, PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { Session } from '../../services/session';
import { CfForm } from '../../ui/cf-form';
import { ScreenHeading } from '../../ui/screen-heading';
import { SettingsStore } from './settings-store';

/**
 * Organisation settings by topic: storage, mail, sign-in emails, API and data feeds, and books and numbering. Each card has
 * its own Save. Sign-in methods are read-only; the platform operator sets them.
 */
@Component({
  selector: 'app-admin-settings',
  imports: [Btn, CfForm, ScreenHeading, TranslatePipe, PageFrame],
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
        <section class="card" aria-labelledby="org-storage-title">
          <h2 id="org-storage-title">{{ 'ui.admin.settings.storage' | t }}</h2>
          <div class="admin__line">
            <span class="admin__grow"></span>
            <span class="muted">{{ store.used() }}</span>
          </div>
          <div class="admin__bar" role="progressbar" aria-labelledby="org-storage-title" [attr.aria-valuetext]="store.used()" [attr.aria-valuenow]="store.percent()" aria-valuemin="0" aria-valuemax="100"><i [style.width.%]="store.percent()"></i></div>
          <cf-form [fields]="store.storage()" [values]="store.values()" [errors]="store.errors()" idPrefix="org-storage" [columns]="2" (valuesChange)="store.values.set($event)" />
          <div class="admin__line admin__line--footer">
            <span class="admin__grow"></span>
            <button appBtn="primary" type="button" [disabled]="store.saving()" (click)="store.save('settings')">{{ (store.saving() ? 'ui.common.saving' : 'ui.common.save') | t }}</button>
          </div>
        </section>
        <section class="card" aria-labelledby="org-mail-title">
          <h2 id="org-mail-title">{{ 'ui.admin.settings.mailTitle' | t }}</h2>
          <p class="muted">{{ 'ui.admin.settings.mailIntro' | t }}</p>
          <cf-form [fields]="store.mail()" [values]="store.values()" [errors]="store.errors()" idPrefix="org-mail" (valuesChange)="store.values.set($event)" />
          <div class="admin__line admin__line--footer">
            <span class="admin__grow"></span>
            <button appBtn="primary" type="button" [disabled]="store.saving()" (click)="store.save('mail')">{{ (store.saving() ? 'ui.common.saving' : 'ui.common.save') | t }}</button>
          </div>
        </section>
        <section class="card" aria-labelledby="org-emails-title">
          <h2 id="org-emails-title">{{ 'ui.admin.settings.emailsTitle' | t }}</h2>
          <p class="muted">{{ 'ui.admin.settings.emailsIntro' | t }}</p>
          <cf-form [fields]="store.emails()" [values]="store.values()" [errors]="store.errors()" idPrefix="org-emails" [columns]="2" (valuesChange)="store.values.set($event)" />
          <div class="admin__line admin__line--footer">
            <span class="admin__grow"></span>
            <button appBtn="primary" type="button" [disabled]="store.saving()" (click)="store.save('emails')">{{ (store.saving() ? 'ui.common.saving' : 'ui.common.save') | t }}</button>
          </div>
        </section>
        <section class="card" aria-labelledby="org-api-title">
          <h2 id="org-api-title">{{ 'ui.admin.settings.apiTitle' | t }}</h2>
          <cf-form [fields]="store.api()" [values]="store.values()" [errors]="store.errors()" idPrefix="org-api" [columns]="2" [fullWidth]="['corsOrigins']" (valuesChange)="store.values.set($event)" />
          <div class="admin__line admin__line--footer">
            <span class="admin__grow"></span>
            <button appBtn="primary" type="button" [disabled]="store.saving()" (click)="store.save('settings')">{{ (store.saving() ? 'ui.common.saving' : 'ui.common.save') | t }}</button>
          </div>
        </section>
        <section class="card" aria-labelledby="org-books-title">
          <h2 id="org-books-title">{{ 'ui.admin.settings.booksTitle' | t }}</h2>
          @if (store.settings()!.financialYearFixed) {
            <dl class="admin__kv">
              <dt>{{ 'ui.admin.settings.fyStart' | t }}</dt>
              <dd>{{ store.fyMonthLabel() }}</dd>
            </dl>
            <p class="muted">{{ 'ui.admin.settings.fyStartFixed' | t }}</p>
          } @else {
            <cf-form [fields]="store.finance()" [values]="store.values()" [errors]="store.errors()" idPrefix="org-books" (valuesChange)="store.values.set($event)" />
            <div class="admin__line admin__line--footer">
              <span class="admin__grow"></span>
              <button appBtn="primary" type="button" [disabled]="store.saving()" (click)="store.save('settings')">{{ (store.saving() ? 'ui.common.saving' : 'ui.common.save') | t }}</button>
            </div>
          }
        </section>
        <div class="admin__footnote" role="note" aria-labelledby="org-sign-in-title">
          <h2 id="org-sign-in-title">{{ 'ui.admin.settings.signIn' | t }}</h2>
          <p>{{ 'ui.admin.settings.signInIntro' | t }}</p>
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
        </div>
      }
    </app-page-frame>
  `,
})
export class SettingsScreen {
  readonly store = inject(SettingsStore);
  private readonly session = inject(Session);
  /** The single sign-on providers the sign-in page offers. The operator sets them; this is read-only. */
  readonly providers = signal<{ id: string; label: string }[] | null>(null);

  constructor() {
    const key = this.session.me()?.tenant.key;
    if (key) void this.session.providers(key).then((list) => this.providers.set(list), () => this.providers.set([]));
  }
}