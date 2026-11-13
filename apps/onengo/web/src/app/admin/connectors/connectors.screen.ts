import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { CfForm } from '../../ui/cf-form';
import { CreateButton } from '../../ui/create-button';
import { FilteredInfiniteList } from '../../ui/filtered-infinite-list';
import { MobileFormSheet } from '../../ui/form-panel';
import { FilteredListPage } from '../../ui/list-page';
import { ScreenHeading } from '../../ui/screen-heading';
import { ConnectorsStore } from './connectors-store';

/** Administration › Connectors: SMS, WhatsApp, webhooks, HTTP calls and account sign-in with what uses each and how the last delivery went. */
@Component({
  selector: 'app-admin-connectors',
  imports: [FilteredListPage, FilteredInfiniteList, MobileFormSheet, CfForm, CreateButton, ScreenHeading, TranslatePipe, PageFrame],
  providers: [ConnectorsStore],
  styleUrls: ['../../ui/styles/na-list-dashboard.css', '../../ui/styles/title-action.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="'ui.crumbs.admin.connectors' | t" />
        @if (!store.narrow()) {
          <button type="button" class="app-btn app-btn--primary admin__title-action" (click)="store.openCreate()">{{ 'ui.admin.connectors.new' | t }}</button>
        }
      </div>
      @let s = store.state();
      <p class="notice info">{{ 'ui.admin.connectors.note' | t }}</p>
      <section class="list-dashboard" [attr.aria-busy]="s.loading">
        <app-filtered-list-page>
          <app-filtered-infinite-list
            [chips]="[]"
            [items]="store.rows()"
            [loading]="s.loading"
            [error]="s.error"
            [searchText]="store.filterText()"
            [searchPlaceholder]="'ui.admin.connectors.search' | t"
            [emptyMessage]="'ui.admin.empty' | t"
            [layout]="store.layout()"
            [columns]="store.columns()"
            badgeKey="state"
            (searchChange)="store.filterText.set($event)"
            (retry)="store.retry()"
            (rowClick)="store.open($event.id)">
          </app-filtered-infinite-list>
        </app-filtered-list-page>
        @if (store.narrow()) {
          <div class="list-dashboard__floating-actions">
            <app-create-button [label]="'ui.admin.connectors.new' | t" (pressed)="store.openCreate()" />
          </div>
        }
      </section>
      <app-mobile-form-sheet
        [open]="store.creating()"
        [title]="'ui.admin.connectors.new' | t"
        [saveLabel]="'ui.common.next' | t"
        (dismissed)="store.closeCreate()"
        (save)="store.create()">
        <cf-form [fields]="store.newFields()" [values]="store.newValues()" [errors]="store.newErrors()" idPrefix="new-connector" (valuesChange)="store.newValues.set($event)" />
      </app-mobile-form-sheet>
    </app-page-frame>
  `,
})
export class ConnectorsScreen {
  readonly store = inject(ConnectorsStore);
}
