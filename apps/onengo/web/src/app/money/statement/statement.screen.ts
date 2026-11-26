import { Component, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Btn, PageFrame } from '@onengo/web-kit';
import { accountSubtitle } from '../../core/money/statement';
import { TranslatePipe } from '../../services/i18n';
import { ScreenHeading } from '../../ui/screen-heading';
import { StatementStore } from './statement-store';

/** An account's statement (`/accounts/:key/statement`): money in and out between two days, with the balance after each line. */
@Component({
  selector: 'app-account-statement',
  imports: [PageFrame, ScreenHeading, TranslatePipe, Btn, RouterLink],
  providers: [StatementStore],
  styleUrls: ['../../admin/admin.css', './statement.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="store.view()?.account?.name ?? ('ui.money.statementTitle' | t)" />
        <button appBtn="" type="button" class="admin__title-action" data-testid="statement-csv" [disabled]="!store.view() || store.loading()" (click)="store.exportCsv()">
          {{ 'ui.money.exportCsv' | t }}
        </button>
      </div>
      @if (store.view(); as v) {
        <p class="muted">{{ subtitle(v) }}</p>
      }

      <form class="statement__range" (submit)="$event.preventDefault(); store.show()">
        <label>
          <span>{{ 'ui.money.fromDate' | t }}</span>
          <input type="date" name="from" data-testid="statement-from" [value]="store.from()" (input)="store.from.set($any($event.target).value)" />
        </label>
        <label>
          <span>{{ 'ui.money.toDate' | t }}</span>
          <input type="date" name="to" data-testid="statement-to" [value]="store.to()" (input)="store.to.set($any($event.target).value)" />
        </label>
        <button appBtn="primary" type="submit" data-testid="statement-show" [disabled]="store.loading()">{{ 'ui.money.show' | t }}</button>
      </form>
      @if (store.rangeError(); as problem) {
        <p class="notice error" role="alert">{{ problem }}</p>
      }
      @if (store.error(); as err) {
        <p class="notice error" role="alert">
          {{ err }} <button appBtn="" type="button" (click)="store.show()">{{ 'ui.common.retry' | t }}</button>
        </p>
      }

      @if (store.view()) {
        <div class="statement__totals" data-testid="statement-totals">
          @for (x of store.totals(); track x.key) {
            <div class="statement__total" [attr.data-testid]="'statement-' + x.key">
              <span>{{ x.label }}</span>
              <b>{{ x.value }}</b>
            </div>
          }
        </div>

        <div class="statement__scroll" [attr.aria-busy]="store.loading()">
          <table class="statement__table" data-testid="statement-table">
            <thead>
              <tr>
                <th>{{ 'ui.money.csv.date' | t }}</th>
                <th>{{ 'ui.money.csv.details' | t }}</th>
                <th class="statement__num">{{ 'ui.money.moneyIn' | t }}</th>
                <th class="statement__num">{{ 'ui.money.moneyOut' | t }}</th>
                <th class="statement__num">{{ 'ui.money.col.balance' | t }}</th>
              </tr>
            </thead>
            <tbody>
              @for (r of store.rows(); track r.id) {
                <tr [class.statement__reversed]="r.reversed" data-testid="statement-row">
                  <td>{{ r.date }}</td>
                  <td>
                    <span>{{ r.details }}</span>
                    <small class="statement__kind">{{ r.kind }}@if (r.reversed) { · {{ 'ui.money.reversed' | t }} }</small>
                    @if (r.link; as l) {
                      <a class="statement__source" [routerLink]="['/records', l.type]" [queryParams]="{ id: l.id }">{{ r.reference ?? ('ui.money.openRecord' | t) }}</a>
                    }
                  </td>
                  <td class="statement__num">{{ r.moneyIn }}</td>
                  <td class="statement__num">{{ r.moneyOut }}</td>
                  <td class="statement__num" [class.statement__negative]="r.negative">{{ r.balance }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="5" class="muted">{{ 'ui.money.noLines' | t }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (store.hasMore()) {
          <button appBtn="" type="button" data-testid="statement-more" [disabled]="store.loading()" (click)="store.more()">{{ 'ui.money.loadMore' | t }}</button>
        }
      } @else if (store.loading()) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      }
    </app-page-frame>
  `,
})
export class AccountStatementScreen {
  readonly store = inject(StatementStore);
  /** The account's key, from the address. */
  readonly key = input.required<string>();
  readonly subtitle = accountSubtitle;

  constructor() {
    effect(() => this.store.key.set(this.key()));
  }
}
