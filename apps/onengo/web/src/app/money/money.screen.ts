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
  styleUrls: ['../ui/styles/na-list-dashboard.css', '../admin/admin.css', './money.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="'ui.money.title' | t" />
        @if (store.canSeeLedger() && !store.narrow()) {
          <button appBtn="" type="button" class="admin__title-action" data-testid="money-trial-balance" (click)="store.openTrialBalance()">{{ 'ui.money.trialBalance' | t }}</button>
        }
        @if (store.canTransfer() && !store.narrow()) {
          <button appBtn="" type="button" class="admin__title-action" data-testid="money-transfer" (click)="store.openTransfer()">{{ 'ui.money.transfer' | t }}</button>
        }
        @if (store.canManage() && !store.narrow()) {
          <button appBtn="primary" type="button" class="admin__title-action" (click)="store.openForm()">{{ 'ui.money.open' | t }}</button>
        }
      </div>
      <p class="muted">{{ 'ui.money.hint' | t }}</p>
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }

      <section class="money-balances" data-testid="money-balances" [attr.aria-label]="'ui.money.balancesTitle' | t">
        <div class="money-balances__head">
          <h2 class="money-balances__title">{{ 'ui.money.balancesTitle' | t }}</h2>
          <label class="money-balances__date">
            <span class="visually-hidden">{{ 'ui.money.asOf' | t }}</span>
            <input type="date" data-testid="money-as-on" [value]="store.asOf()" (change)="store.setAsOf($any($event.target).value)" />
          </label>
          <button appBtn="" type="button" data-testid="money-balances-csv" [disabled]="!store.balances()" (click)="store.exportBalances()">{{ 'ui.money.exportCsv' | t }}</button>
        </div>
        @if (store.balancesError(); as err) {
          <p class="notice error" role="alert">{{ err }}</p>
        } @else if (store.balanceLines(); as b) {
          <div class="money-balances__grid">
            <div class="money-balances__item money-balances__item--total">
              <span>{{ 'ui.money.total' | t }}</span>
              <b data-testid="money-total">{{ b.total }}</b>
            </div>
            @for (a of b.accounts; track a.key) {
              <div class="money-balances__item" [attr.data-testid]="'money-balance-' + a.key">
                <span>{{ a.name }}</span>
                <b>{{ a.balance }}</b>
              </div>
            }
          </div>
          <p class="muted">{{ 'ui.money.balancesHint' | t }}</p>
        }
      </section>
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

      @if (store.narrow() && (store.canTransfer() || store.canSeeLedger())) {
        <div class="money-balances__actions">
          @if (store.canTransfer()) {
            <button appBtn="" type="button" (click)="store.openTransfer()">{{ 'ui.money.transfer' | t }}</button>
          }
          @if (store.canSeeLedger()) {
            <button appBtn="" type="button" (click)="store.openTrialBalance()">{{ 'ui.money.trialBalance' | t }}</button>
          }
        </div>
      }

      <app-mobile-form-sheet
        [open]="store.transferring()"
        [title]="'ui.money.transferTitle' | t"
        [saving]="store.busy()"
        [saveLabel]="(store.askReason() || store.overdraws() ? 'ui.money.transferWithReason' : 'ui.money.transfer') | t"
        (dismissed)="store.closeTransfer()"
        (save)="store.transfer()">
        <cf-form
          [fields]="store.transferFields()"
          [values]="store.transferValues()"
          [errors]="store.transferErrors()"
          idPrefix="transfer"
          (valuesChange)="store.transferValues.set($event)" />
        @if (store.transferNote(); as note) {
          <p class="muted" data-testid="transfer-after">{{ note }}</p>
        }
      </app-mobile-form-sheet>

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
