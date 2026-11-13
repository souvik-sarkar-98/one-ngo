import { Component, inject } from '@angular/core';
import { opensInPlace, PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../services/i18n';
import { ScreenHeading } from '../ui/screen-heading';
import { AdminHomeStore } from './admin-home-store';
import { OrganisationSections } from './settings/organisation-sections';

/** Administration's home: the setup still to do, then the areas the person may open. */
@Component({
  selector: 'app-admin-home',
  imports: [ScreenHeading, TranslatePipe, PageFrame, OrganisationSections],
  providers: [AdminHomeStore],
  styleUrl: './admin.css',
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.administration' | t" />
      <p class="muted">{{ 'ui.admin.homeIntro' | t }}</p>
      @if (store.canSettings()) {
        <app-organisation-sections />
      }
      @let h = store.home();
      @if (h.organisation.length) {
        <h2 class="admin__caption" id="admin-organisation">{{ 'ui.admin.organisation' | t }}</h2>
        <ul class="admin__list">
          @for (a of h.organisation; track a.id) {
            <li><a class="admin__row" [attr.href]="a.link" (click)="follow($event, a.link)"><span class="admin__label"><strong>{{ a.label }}</strong><span class="muted">{{ a.hint }}</span></span>›</a></li>
          }
        </ul>
      }
      @if (h.people.length) {
        <h2 class="admin__caption" id="admin-people">{{ 'ui.admin.people' | t }}</h2>
        <ul class="admin__list">
          @for (a of h.people; track a.id) {
            <li><a class="admin__row" [attr.href]="a.link" (click)="follow($event, a.link)"><span class="admin__label"><strong>{{ a.label }}</strong><span class="muted">{{ a.hint }}</span></span>›</a></li>
          }
        </ul>
      }
      @if (h.integrations.length) {
        <h2 class="admin__caption" id="admin-integrations">{{ 'ui.admin.integrations' | t }}</h2>
        <ul class="admin__list">
          @for (a of h.integrations; track a.id) {
            <li><a class="admin__row" [attr.href]="a.link" (click)="follow($event, a.link)"><span class="admin__label"><strong>{{ a.label }}</strong><span class="muted">{{ a.hint }}</span></span>›</a></li>
          }
        </ul>
      }
      @if (h.data.length) {
        <h2 class="admin__caption" id="admin-data">{{ 'ui.admin.data' | t }}</h2>
        <ul class="admin__list">
          @for (a of h.data; track a.id) {
            <li><a class="admin__row" [attr.href]="a.link" (click)="follow($event, a.link)"><span class="admin__label"><strong>{{ a.label }}</strong><span class="muted">{{ a.hint }}</span></span>›</a></li>
          }
        </ul>
      }
      @if (h.activity.length) {
        <h2 class="admin__caption" id="admin-activity">{{ 'ui.admin.activity' | t }}</h2>
        <ul class="admin__list">
          @for (a of h.activity; track a.id) {
            <li><a class="admin__row" [attr.href]="a.link" (click)="follow($event, a.link)"><span class="admin__label"><strong>{{ a.label }}</strong><span class="muted">{{ a.hint }}</span></span>›</a></li>
          }
        </ul>
      }
    </app-page-frame>
  `,
})
export class AdminHomeScreen {
  readonly store = inject(AdminHomeStore);

  follow(e: MouseEvent, link: string): void {
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.store.go(link);
  }
}
