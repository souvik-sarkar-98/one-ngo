import { Injectable, computed, inject, signal } from '@angular/core';
import { todayLocal } from '../../core/money/money';
import {
  dayIssue,
  difference,
  endOfLastMonth,
  groupRows,
  totalsText,
  trialBalanceCsv,
  trialBalanceFileName,
  trialBalanceUrl,
  type TrialBalanceView,
} from '../../core/money/trial-balance';
import { Api } from '../../services/api';
import { I18n } from '../../services/i18n';
import { saveTextFile } from '../../ui/save-file';
import { failureText } from '../money-store';

/** The trial balance (`/accounts/trial-balance`): every ledger account's balance on a day, with the totals that must agree. */
@Injectable()
export class TrialBalanceStore {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);

  readonly asOf = signal(todayLocal());
  readonly includeZero = signal(false);
  readonly view = signal<TrialBalanceView | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly dayError = signal('');

  readonly groups = computed(() => {
    this.i18n.locale();
    const v = this.view();
    return v ? groupRows(v.rows) : [];
  });
  readonly totals = computed(() => {
    this.i18n.locale();
    const v = this.view();
    return v ? totalsText(v) : null;
  });
  readonly difference = computed(() => {
    const v = this.view();
    return v ? difference(v) : '0.00';
  });

  constructor() {
    void this.load();
  }

  /** Reads the trial balance for the day in the box. */
  async load(): Promise<void> {
    const issue = dayIssue(this.asOf());
    this.dayError.set(issue ?? '');
    if (issue) return;
    this.loading.set(true);
    this.error.set('');
    try {
      this.view.set(await this.api.get<TrialBalanceView>(trialBalanceUrl(this.asOf(), this.includeZero())));
    } catch (e) {
      this.view.set(null);
      this.error.set(failureText(e));
    } finally {
      this.loading.set(false);
    }
  }

  setIncludeZero(on: boolean): void {
    this.includeZero.set(on);
    void this.load();
  }

  today(): void {
    this.asOf.set(todayLocal());
    void this.load();
  }

  lastMonthEnd(): void {
    this.asOf.set(endOfLastMonth(todayLocal()));
    void this.load();
  }

  /** The last day of the financial year the shown day is in. */
  yearEnd(): void {
    const end = this.view()?.year.endsOn;
    if (!end) return;
    this.asOf.set(end);
    void this.load();
  }

  exportCsv(): void {
    const v = this.view();
    if (v) saveTextFile(trialBalanceFileName(v), trialBalanceCsv(v));
  }

  print(): void {
    window.print();
  }
}
