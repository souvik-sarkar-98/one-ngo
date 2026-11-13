import { Component, inject } from '@angular/core';
import { PageFrame, opensInPlace } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { CfForm } from '../../ui/cf-form';
import { ScreenHeading } from '../../ui/screen-heading';
import { OrganisationStore } from './organisation-store';

/** Profile: how to reach the organisation, its address and time zone, saved to the organisation profile. The logo and names are on Identity. */
@Component({
  selector: 'app-admin-profile',
  imports: [CfForm, PageFrame, ScreenHeading, TranslatePipe],
  providers: [OrganisationStore],
  styleUrl: '../admin.css',
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.profile' | t" />
      <p class="muted">{{ 'ui.admin.organisation.profileIntro' | t }}</p>
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      @if (store.error()) {
        <div class="notice error" role="alert">{{ store.error() }}</div>
      }
      @if (store.loading()) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      } @else if (store.view()) {
        @if (store.legalNameMissing()) {
          <div class="notice" role="status">
            {{ 'ui.admin.organisation.legalNameMissing' | t }}
            <a [attr.href]="'/admin/organisation/identity'" (click)="openIdentity($event)">{{ 'ui.admin.organisation.goIdentity' | t }}</a>
          </div>
        }
        <section class="card">
          <cf-form [fields]="store.contactFields()" [values]="store.profile()" [errors]="store.profileErrors()" idPrefix="org-contact" [columns]="3" (valuesChange)="store.profile.set($event)" />
          <h3>{{ 'ui.admin.organisation.addressTitle' | t }}</h3>
          <cf-form [fields]="store.addressFields()" [values]="store.profile()" [errors]="store.profileErrors()" idPrefix="org-address" [columns]="3" (valuesChange)="store.profile.set($event)" />
          <div class="admin__line">
            <span class="admin__grow"></span>
            <button type="button" class="app-btn app-btn--primary" [disabled]="store.savingProfile()" (click)="store.saveProfile()">
              {{ (store.savingProfile() ? 'ui.common.saving' : 'ui.common.save') | t }}
            </button>
          </div>
        </section>
      }
    </app-page-frame>
  `,
})
export class ProfileScreen {
  readonly store = inject(OrganisationStore);

  openIdentity(e: MouseEvent): void {
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.store.go('/admin/organisation/identity');
  }
}
