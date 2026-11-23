import { Component, inject } from '@angular/core';
import { Btn, PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../services/i18n';
import { CfForm } from '../ui/cf-form';
import { CreateButton } from '../ui/create-button';
import { FilteredInfiniteList } from '../ui/filtered-infinite-list';
import { MobileFormSheet } from '../ui/form-panel';
import { FilteredListPage } from '../ui/list-page';
import { ScreenHeading } from '../ui/screen-heading';
import { MoneyStore } from './money-store';

/** Money accounts (`/accounts`): each account's kind, ledger account, UPI ID and balance; opening a new one for people who may manage accounts. */
@Component({
  selector: 'app-money',
  imports: [FilteredListPage, FilteredInfiniteList, MobileFormSheet, CfForm, CreateButton, ScreenHeading, TranslatePipe, PageFrame, Btn],
  providers: [MoneyStore],
  styleUrls: ['../ui/styles/na-list-dashboard.css', '../admin/admin.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="'ui.money.title' | t" />
        @if (store.canManage() && !store.narrow()) {
          <button appBtn="primary" type="button" class="admin__title-action" (click)="store.openForm()">{{ 'ui.money.open' | t }}</button>
        }
      </div>
      <p class="muted">{{ 'ui.money.hint' | t }}</p>
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      <section class="list-dashboard" [attr.aria-busy]="store.loading()">
        <app-filtered-list-page>
          <app-filtered-infinite-list
            [chips]="[]"
            [toolbar]="false"
            [items]="store.rows()"
            [loading]="store.loading()"
            [error]="store.error()"
            [emptyMessage]="'ui.money.empty' | t"
            [layout]="store.layout()"
            [columns]="store.columns()"
            badgeKey="status"
            (rowAction)="store.rowAction($event.row.id, $event.action)"
            (retry)="store.load()">
          </app-filtered-infinite-list>
        </app-filtered-list-page>
        @if (store.canManage() && store.narrow()) {
          <div class="list-dashboard__floating-actions">
            <app-create-button [label]="'ui.money.open' | t" (pressed)="store.openForm()" />
          </div>
        }
      </section>

      <app-mobile-form-sheet
        [open]="store.opening()"
        [title]="(store.editing() ? 'ui.money.editTitle' : 'ui.money.openTitle') | t"
        [saving]="store.busy()"
        [saveLabel]="(store.editing() ? 'ui.money.saveEdit' : 'ui.money.save') | t"
        (dismissed)="store.closeForm()"
        (save)="store.save()">
        <cf-form [fields]="store.fields()" [values]="store.values()" [errors]="store.errors()" idPrefix="money" (valuesChange)="store.values.set($event)" />
      </app-mobile-form-sheet>
    </app-page-frame>
  `,
})
export class MoneyScreen {
  readonly store = inject(MoneyStore);
}
