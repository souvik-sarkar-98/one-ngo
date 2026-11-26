import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Btn, PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { ScreenHeading } from '../../ui/screen-heading';
import { TrialBalanceStore } from './trial-balance-store';

/** The trial balance (`/accounts/trial-balance`): every ledger account's balance on a day, in a Debit or a Credit column. */
@Component({
  selector: 'app-trial-balance',
  imports: [PageFrame, ScreenHeading, TranslatePipe, Btn, RouterLink],
  providers: [TrialBalanceStore],
  styleUrls: ['../../admin/admin.css', '../statement/statement.css', './trial-balance.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="'ui.money.tb.title' | t" />
        @if (store.view(); as v) {
          <span class="tb__badge" [class.tb__badge--bad]="!v.balanced" data-testid="tb-badge">{{ (v.balanced ? 'ui.money.tb.balanced' : 'ui.money.tb.outOfBalance') | t }}</span>
        }
        <button appBtn="" type="button" class="admin__title-action tb__noprint" data-testid="tb-print" [disabled]="!store.view()" (click)="store.print()">{{ 'ui.money.tb.print' | t }}</button>
        <button appBtn="" type="button" class="admin__title-action tb__noprint" data-testid="tb-csv" [disabled]="!store.view()" (click)="store.exportCsv()">{{ 'ui.money.exportCsv' | t }}</button>
      </div>
      <p class="muted">{{ 'ui.money.tb.intro' | t }}</p>

      <form class="statement__range tb__noprint" (submit)="$event.preventDefault(); store.load()">
        <label>
          <span>{{ 'ui.money.asOf' | t }}</span>
          <input type="date" name="asOf" data-testid="tb-as-on" [value]="store.asOf()" (input)="store.asOf.set($any($event.target).value)" />
        </label>
        <button appBtn="" type="button" (click)="store.today()">{{ 'ui.money.tb.today' | t }}</button>
        <button appBtn="" type="button" (click)="store.lastMonthEnd()">{{ 'ui.money.tb.lastMonth' | t }}</button>
        <button appBtn="" type="button" [disabled]="!store.view()" (click)="store.yearEnd()">{{ 'ui.money.tb.yearEnd' | t }}</button>
        <button appBtn="primary" type="submit" data-testid="tb-show" [disabled]="store.loading()">{{ 'ui.money.show' | t }}</button>
      </form>
      <label class="tb__zero tb__noprint">
        <input type="checkbox" data-testid="tb-zero" [checked]="store.includeZero()" (change)="store.setIncludeZero($any($event.target).checked)" />
        {{ 'ui.money.tb.showZero' | t }}
      </label>
      @if (store.dayError(); as problem) {
        <p class="notice error" role="alert">{{ problem }}</p>
      }
      @if (store.error(); as err) {
        <p class="notice error" role="alert">
          {{ err }} <button appBtn="" type="button" (click)="store.load()">{{ 'ui.common.retry' | t }}</button>
        </p>
      }

      @if (store.view(); as v) {
        <p class="muted" data-testid="tb-year">{{ 'ui.money.tb.yearNote' | t: { year: v.year.key } }}</p>
        @if (!v.balanced) {
          <p class="notice error" role="alert" data-testid="tb-bad">{{ 'ui.money.tb.badNote' | t: { amount: store.difference() } }}</p>
        }
        <div class="statement__scroll" [attr.aria-busy]="store.loading()">
          <table class="statement__table tb__table" data-testid="tb-table">
            <thead>
              <tr>
                <th>{{ 'ui.money.tb.code' | t }}</th>
                <th>{{ 'ui.money.tb.account' | t }}</th>
                <th class="statement__num">{{ 'ui.money.tb.debit' | t }}</th>
                <th class="statement__num">{{ 'ui.money.tb.credit' | t }}</th>
              </tr>
            </thead>
            @for (g of store.groups(); track g.key) {
              <tbody>
                <tr class="tb__group">
                  <td colspan="4">
                    <b>{{ g.title }}</b> <span class="muted">{{ g.hint }}</span>
                  </td>
                </tr>
                @for (r of g.rows; track r.code) {
                  <tr data-testid="tb-row" [attr.data-code]="r.code">
                    <td>{{ r.code }}</td>
                    <td>
                      @if (r.moneyKey) {
                        <a [routerLink]="['/accounts', r.moneyKey, 'statement']">{{ r.name }}</a>
                      } @else {
                        {{ r.name }}
                      }
                      @if (r.inactive) {
                        <small class="statement__kind">{{ 'ui.money.tb.closed' | t }}</small>
                      }
                    </td>
                    <td class="statement__num">{{ r.debit }}</td>
                    <td class="statement__num">{{ r.credit }}</td>
                  </tr>
                }
              </tbody>
            } @empty {
              <tbody>
                <tr>
                  <td colspan="4" class="muted" data-testid="tb-empty">{{ 'ui.money.tb.empty' | t: { date: v.asOf } }}</td>
                </tr>
              </tbody>
            }
            @if (store.totals(); as tot) {
              <tfoot>
                <tr class="tb__total" data-testid="tb-total">
                  <td colspan="2">{{ 'ui.money.tb.total' | t }}</td>
                  <td class="statement__num" data-testid="tb-total-debit">{{ tot.debit }}</td>
                  <td class="statement__num" data-testid="tb-total-credit">{{ tot.credit }}</td>
                </tr>
              </tfoot>
            }
          </table>
        </div>
        @if (v.balanced) {
          <p class="notice" role="status">{{ 'ui.money.tb.balancedNote' | t }}</p>
        }
      } @else if (store.loading()) {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      }
    </app-page-frame>
  `,
})
export class TrialBalanceScreen {
  readonly store = inject(TrialBalanceStore);
}
