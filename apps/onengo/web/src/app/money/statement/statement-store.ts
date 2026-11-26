import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { t } from '../../core/i18n/i18n';
import { rangeIssue, statementCsv, statementFileName, statementRow, statementTotals, statementUrl, type StatementLine, type StatementView } from '../../core/money/statement';
import { Api } from '../../services/api';
import { I18n } from '../../services/i18n';
import { ScreenMeta } from '../../services/screen-meta';
import { saveTextFile } from '../../ui/save-file';
import { failureText } from '../money-store';

/**
 * An account's statement (`/accounts/:key/statement`): its ledger between two days with a running balance.
 * The days start as the current financial year, which the server chooses.
 */
@Injectable()
export class StatementStore {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  private readonly meta = inject(ScreenMeta);

  /** The account key from the address. */
  readonly key = signal('');
  readonly view = signal<StatementView | null>(null);
  /** Lines loaded so far; the first page, then more as the person asks. */
  readonly lines = signal<StatementLine[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  /** The days typed in the boxes; they apply when the person presses Show. */
  readonly from = signal('');
  readonly to = signal('');
  readonly rangeError = signal('');

  readonly rows = computed(() => {
    this.i18n.locale();
    return this.lines().map(statementRow);
  });
  readonly totals = computed(() => {
    this.i18n.locale();
    const v = this.view();
    return v ? statementTotals(v) : [];
  });
  readonly hasMore = computed(() => !!this.view() && this.lines().length < this.view()!.count);

  constructor() {
    effect(() => {
      const key = this.key();
      if (key) untracked(() => void this.load({}));
    });
  }

  /** Loads the first page of the range, or the server's default range when none is given. */
  async load(range: { from?: string; to?: string }): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const view = await this.api.get<StatementView>(statementUrl(this.key(), range));
      this.view.set(view);
      this.lines.set(view.lines);
      this.from.set(view.from);
      this.to.set(view.to);
      this.meta.crumbLabels.set({ account: view.account.name });
    } catch (e) {
      this.view.set(null);
      this.lines.set([]);
      this.error.set(failureText(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Applies the days in the boxes. */
  show(): Promise<void> {
    const issue = rangeIssue(this.from(), this.to());
    this.rangeError.set(issue ?? '');
    return issue ? Promise.resolve() : this.load({ from: this.from(), to: this.to() });
  }

  async more(): Promise<void> {
    const v = this.view();
    if (!v || this.loading()) return;
    this.loading.set(true);
    try {
      const next = await this.api.get<StatementView>(statementUrl(this.key(), { from: v.from, to: v.to }, this.lines().length));
      this.lines.update((l) => [...l, ...next.lines]);
    } catch (e) {
      this.error.set(failureText(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Downloads the whole range as a CSV, fetching the pages not yet loaded. */
  async exportCsv(): Promise<void> {
    const v = this.view();
    if (!v) return;
    this.loading.set(true);
    try {
      const all = [...this.lines()];
      while (all.length < v.count) {
        const next = await this.api.get<StatementView>(statementUrl(this.key(), { from: v.from, to: v.to }, all.length));
        if (!next.lines.length) break;
        all.push(...next.lines);
      }
      saveTextFile(statementFileName(v), statementCsv(v, all));
    } catch (e) {
      this.error.set(failureText(e) || t('ui.common.somethingWentWrong'));
    } finally {
      this.loading.set(false);
    }
  }
}
