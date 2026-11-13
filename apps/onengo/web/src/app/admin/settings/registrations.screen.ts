import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { CfForm } from '../../ui/cf-form';
import { ScreenHeading } from '../../ui/screen-heading';
import { OrganisationStore } from './organisation-store';

/** Registrations: the certificates the organisation holds, each kept on its own row in the organisation registrations. */
@Component({
  selector: 'app-admin-registrations',
  imports: [CfForm, PageFrame, ScreenHeading, TranslatePipe],
  providers: [OrganisationStore],
  styleUrl: '../admin.css',
  styles: `
    .org__error {
      color: var(--bad, #b91c1c);
      font-size: 0.85rem;
    }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.registrations' | t" />
      <p class="muted">{{ 'ui.admin.organisation.registrationsIntro' | t }}</p>
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      @if (store.error()) {
        <div class="notice error" role="alert">{{ store.error() }}</div>
      }
      @if (store.loading()) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      } @else if (store.view()) {
        <section class="card" aria-labelledby="org-registrations-title">
          <div class="admin__line">
            <h2 id="org-registrations-title" class="admin__grow">{{ 'ui.admin.organisation.registrationsTitle' | t }}</h2>
            @if (store.editing() === null) {
              <button type="button" class="app-btn" (click)="store.editRegistration('new')">{{ 'ui.admin.organisation.addRegistration' | t }}</button>
            }
          </div>
          @if (!store.registrations().length) {
            <p class="muted">{{ 'ui.admin.organisation.noRegistrations' | t }}</p>
          } @else {
            <ul class="admin__list">
              @for (r of store.registrations(); track r.id) {
                <li>
                  <div class="admin__row">
                    <span class="admin__label">
                      <strong>{{ r.line }}</strong>
                      @if (r.dates) {
                        <span class="muted">{{ r.dates }}</span>
                      }
                    </span>
                    <button type="button" class="app-btn" [attr.aria-label]="'ui.admin.organisation.editRegistration' | t: { name: r.line }" (click)="store.editRegistration(r.id)">
                      {{ 'ui.common.edit' | t }}
                    </button>
                    <button
                      type="button"
                      class="app-btn"
                      [attr.aria-label]="(store.removing() === r.id ? 'ui.admin.organisation.confirmRemove' : 'ui.admin.organisation.removeRegistration') | t: { name: r.line }"
                      (click)="store.removeRegistration(r.id)">
                      {{ (store.removing() === r.id ? 'ui.admin.organisation.confirmRemoveShort' : 'ui.common.remove') | t }}
                    </button>
                  </div>
                </li>
              }
            </ul>
          }
          @if (store.editing() !== null) {
            <div class="card" role="group" aria-labelledby="org-registration-edit">
              <h3 id="org-registration-edit">{{ (store.editing() === 'new' ? 'ui.admin.organisation.addRegistration' : 'ui.admin.organisation.changeRegistration') | t }}</h3>
              <cf-form [fields]="store.registrationFields()" [values]="store.registration()" [errors]="store.registrationErrors()" idPrefix="org-registration" [columns]="2" [fullWidth]="['notes']" (valuesChange)="store.registration.set($event)" />
              <div class="admin__line">
                <span class="admin__grow"></span>
                <button type="button" class="app-btn" (click)="store.cancelRegistration()">{{ 'ui.common.cancel' | t }}</button>
                <button type="button" class="app-btn app-btn--primary" [disabled]="store.savingRegistration()" (click)="store.saveRegistration()">
                  {{ (store.savingRegistration() ? 'ui.common.saving' : 'ui.common.save') | t }}
                </button>
              </div>
            </div>
          }
        </section>
      }
    </app-page-frame>
  `,
})
export class RegistrationsScreen {
  readonly store = inject(OrganisationStore);
}
