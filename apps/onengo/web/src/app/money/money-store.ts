import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { csvOf } from '../core/money/csv';
import {
  MONEY_KINDS,
  editAccountValues,
  isDay,
  kindLabel,
  moneyColumns,
  moneyRow,
  openAccountDefaults,
  todayLocal,
  transferAfter,
  transferDefaults,
  validateEditAccount,
  validateOpenAccount,
  validateTransfer,
  wouldOverdraw,
  paise,
  type BalancesView,
  type MoneyAccount,
} from '../core/money/money';
import { formatMoney, t } from '../core/i18n/i18n';
import type { FormValues } from '../core/records/record/forms';
import type { Notice } from '../records/notice';
import { Api, ApiError } from '../services/api';
import { I18n } from '../services/i18n';
import { Session } from '../services/session';
import type { CfFieldDef } from '../ui/cf-types';
import { saveTextFile } from '../ui/save-file';
import { Viewport } from '../ui/viewport';

/** The money page: every account with its ledger balance, and opening a new one for people who may manage accounts. */
@Injectable()
export class MoneyStore {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  readonly narrow = inject(Viewport).narrow;
  readonly layout = computed(() => (this.narrow() ? 'cards' : 'table'));

  readonly accounts = signal<MoneyAccount[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly opening = signal(false);
  /** The account being edited, or null when the form opens a new one. */
  readonly editing = signal<MoneyAccount | null>(null);
  readonly values = signal<FormValues>(openAccountDefaults());
  readonly errors = signal<Record<string, string>>({});
  readonly notice = signal<Notice | null>(null);

  /** Opening accounts needs `money:accounts:manage`; the list only needs `money:accounts:read`. */
  readonly canManage = computed(() => !!this.session.me()?.capabilities.moneyManage);
  readonly columns = computed(() => {
    this.i18n.locale();
    return moneyColumns();
  });
  /** Pairing a bank statement needs `money:reconcile`, and moving money between accounts needs `money:transfer`. */
  readonly canReconcile = computed(() => !!this.session.me()?.capabilities.moneyReconcile);
  readonly canTransfer = computed(() => !!this.session.me()?.capabilities.moneyTransfer);
  /** The trial balance needs `ledger:read`. */
  readonly canSeeLedger = computed(() => !!this.session.me()?.capabilities.ledger);
  readonly rows = computed(() => {
    this.i18n.locale();
    const caps = { manage: this.canManage(), reconcile: this.canReconcile(), transfer: this.canTransfer() };
    return this.accounts().map((a) => moneyRow(a, caps));
  });

  // ---------------------------------------------------------------- balances on a date

  readonly asOf = signal(todayLocal());
  readonly balances = signal<BalancesView | null>(null);
  readonly balancesError = signal('');
  /** The accounts and total of the balances card, as money text. */
  readonly balanceLines = computed(() => {
    this.i18n.locale();
    const b = this.balances();
    return b ? { total: formatMoney(Number(b.total)), accounts: b.accounts.map((a) => ({ key: a.key, name: a.name, balance: formatMoney(Number(a.balance)) })) } : null;
  });

  /** Moves the card to another day. A date that is not a day is ignored until it is. */
  setAsOf(value: string): void {
    if (!isDay(value)) return;
    this.asOf.set(value);
    void this.loadBalances();
  }

  async loadBalances(): Promise<void> {
    this.balancesError.set('');
    try {
      this.balances.set(await this.api.get<BalancesView>('/api/money/balances?asOf=' + encodeURIComponent(this.asOf())));
    } catch (e) {
      this.balancesError.set(failureText(e));
    }
  }

  /** The balances on the card as a CSV, for the day shown. */
  exportBalances(): void {
    const b = this.balances();
    if (!b) return;
    saveTextFile(
      `balances-${b.asOf}.csv`,
      csvOf([[t('ui.money.col.name'), t('ui.money.col.ledger'), t('ui.money.col.kind'), t('ui.money.col.balance')], ...b.accounts.map((a) => [a.name, a.ledgerCode, kindLabel(a.kind), a.balance]), [t('ui.money.total'), '', '', b.total]]),
    );
  }

  // ---------------------------------------------------------------- transfers

  readonly transferring = signal(false);
  readonly transferValues = signal<FormValues>({});
  readonly transferErrors = signal<Record<string, string>>({});
  /** The server refused for want of money: the reason box is shown and required. */
  readonly askReason = signal(false);
  readonly active = computed(() => this.accounts().filter((a) => a.status === 'active'));

  /** Whether the amount typed would take the sending account below zero, from the balances on the page. */
  readonly overdraws = computed(() => wouldOverdraw(this.transferValues(), this.active()));
  readonly transferNote = computed(() => {
    this.i18n.locale();
    const after = transferAfter(this.transferValues(), this.active());
    if (!after) return '';
    return t('ui.money.transferAfter', { from: after.from, fromBalance: formatMoney(paise(after.fromBalance) / 100), to: after.to, toBalance: formatMoney(paise(after.toBalance) / 100) });
  });
  readonly transferFields = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    const options = this.active().map((a) => ({ key: a.key, label: `${a.name} (${formatMoney(Number(a.balance))})` }));
    const reason = this.askReason() || this.overdraws();
    const sender = this.active().find((a) => a.key === this.transferValues()['from']);
    return [
      { key: 'from', label: t('ui.money.transferFrom'), type: 'select', required: true, readOnly: false, options },
      { key: 'to', label: t('ui.money.transferTo'), type: 'select', required: true, readOnly: false, options },
      { key: 'amount', label: t('ui.money.transferAmount'), type: 'number', required: true, readOnly: false, options: [] },
      { key: 'date', label: t('ui.money.transferDate'), type: 'date', required: true, readOnly: false, options: [] },
      { key: 'reference', label: t('ui.money.transferReference'), type: 'text', required: false, readOnly: false, options: [], placeholder: t('ui.money.transferReferenceHint') },
      ...(reason
        ? [
            {
              key: 'overrideReason',
              label: t('ui.money.overrideReason'),
              type: 'text' as const,
              required: true,
              readOnly: false,
              options: [],
              placeholder: t('ui.money.overrideReasonHint'),
              hint: sender ? t('ui.money.overdrawWarning', { name: sender.name }) : undefined,
            },
          ]
        : []),
    ];
  });

  openTrialBalance(): void {
    void this.router.navigate(['/accounts', 'trial-balance']);
  }

  openTransfer(from?: string): void {
    this.transferValues.set(transferDefaults(this.active(), from));
    this.transferErrors.set({});
    this.askReason.set(false);
    this.transferring.set(true);
  }

  closeTransfer(): void {
    this.transferring.set(false);
  }

  async transfer(): Promise<void> {
    const checked = validateTransfer(this.transferValues(), this.active(), this.askReason());
    if (!checked.ok) {
      this.transferErrors.set(checked.issues);
      return;
    }
    this.transferErrors.set({});
    this.busy.set(true);
    try {
      await this.api.post('/api/money/transfers', checked.body);
      this.closeTransfer();
      this.notice.set({ level: 'success', message: t('ui.money.transferred', { amount: formatMoney(paise(checked.body.amount) / 100) }) });
      await Promise.all([this.load(), this.loadBalances()]);
    } catch (e) {
      // The server's word on money is final. When it says the account is short, ask for the reason and let the person send it again.
      if (e instanceof ApiError && /has only/.test(e.message) && !this.askReason()) {
        this.askReason.set(true);
        this.transferErrors.set({ overrideReason: t('ui.money.reasonNeeded') });
      } else {
        this.transferErrors.set({});
        this.notice.set({ level: 'error', message: failureText(e) });
        this.closeTransfer();
      }
    } finally {
      this.busy.set(false);
    }
  }
  readonly fields = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    if (this.editing()) {
      const fixed = { required: false, readOnly: true, options: [] as { key: string; label: string }[], hint: t('ui.money.fixedHint') };
      return [
        { key: 'key', label: t('ui.money.key'), type: 'text', ...fixed },
        { key: 'name', label: t('ui.money.accountName'), type: 'text', required: true, readOnly: false, options: [] },
        { key: 'kind', label: t('ui.money.kindField'), type: 'text', ...fixed },
        { key: 'ledgerCode', label: t('ui.money.ledgerField'), type: 'text', ...fixed },
        { key: 'upiId', label: t('ui.money.upiField'), type: 'text', required: false, readOnly: false, options: [], hint: t('ui.money.upiHint') },
        { key: 'custodian', label: t('ui.money.custodian'), type: 'text', required: false, readOnly: false, options: [], hint: t('ui.money.custodianHint') },
        { key: 'allowNegative', label: t('ui.money.allowNegative'), type: 'boolean', required: false, readOnly: false, options: [] },
      ];
    }
    return [
      { key: 'key', label: t('ui.money.key'), type: 'text', required: true, readOnly: false, options: [], hint: t('ui.money.keyHint') },
      { key: 'name', label: t('ui.money.accountName'), type: 'text', required: true, readOnly: false, options: [] },
      {
        key: 'kind',
        label: t('ui.money.kindField'),
        type: 'select',
        required: true,
        readOnly: false,
        options: MONEY_KINDS.map((k) => ({ key: k, label: kindLabel(k) })),
      },
      { key: 'upiId', label: t('ui.money.upiField'), type: 'text', required: false, readOnly: false, options: [], hint: t('ui.money.upiHint') },
      { key: 'ledgerCode', label: t('ui.money.ledgerField'), type: 'text', required: false, readOnly: false, options: [], hint: t('ui.money.ledgerHint') },
      { key: 'custodian', label: t('ui.money.custodian'), type: 'text', required: false, readOnly: false, options: [], hint: t('ui.money.custodianHint') },
      { key: 'allowNegative', label: t('ui.money.allowNegative'), type: 'boolean', required: false, readOnly: false, options: [] },
    ];
  });

  constructor() {
    void this.load();
    void this.loadBalances();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.accounts.set(await this.api.get<MoneyAccount[]>('/api/money/accounts'));
    } catch (e) {
      this.error.set(failureText(e));
    } finally {
      this.loading.set(false);
    }
  }

  openForm(): void {
    this.editing.set(null);
    this.values.set(openAccountDefaults());
    this.errors.set({});
    this.opening.set(true);
  }

  closeForm(): void {
    this.opening.set(false);
    this.editing.set(null);
  }

  /** A row's menu: Statement and Reconcile open their screens, Transfer opens the dialog, Edit opens the form on that account. */
  rowAction(id: string, action: string): void {
    const account = this.accounts().find((a) => a.id === id);
    if (!account) return;
    if (action === 'statement') {
      void this.router.navigate(['/accounts', account.key, 'statement']);
      return;
    }
    if (action === 'reconcile' && this.canReconcile() && account.kind !== 'cash') {
      void this.router.navigate(['/accounts', account.key, 'reconcile']);
      return;
    }
    if (action === 'transfer' && this.canTransfer()) {
      this.openTransfer(account.key);
      return;
    }
    if (action !== 'edit' || !this.canManage()) return;
    this.editing.set(account);
    this.values.set(editAccountValues(account));
    this.errors.set({});
    this.opening.set(true);
  }

  /** Saves the form: opens a new account, or changes the one being edited. */
  save(): Promise<void> {
    return this.editing() ? this.update() : this.open();
  }

  private async update(): Promise<void> {
    const account = this.editing();
    if (!account) return;
    const checked = validateEditAccount(this.values());
    if (!checked.ok) {
      this.errors.set(checked.issues);
      return;
    }
    this.errors.set({});
    this.busy.set(true);
    try {
      const saved = await this.api.patch<MoneyAccount>('/api/money/accounts/' + encodeURIComponent(account.key), checked.body);
      this.closeForm();
      this.notice.set({ level: 'success', message: t('ui.money.updated', { name: saved.name }) });
      await this.load();
    } catch (e) {
      this.notice.set({ level: 'error', message: failureText(e) });
    } finally {
      this.busy.set(false);
    }
  }

  async open(): Promise<void> {
    const checked = validateOpenAccount(this.values());
    if (!checked.ok) {
      this.errors.set(checked.issues);
      return;
    }
    this.errors.set({});
    this.busy.set(true);
    try {
      const account = await this.api.post<MoneyAccount>('/api/money/accounts', checked.body);
      this.closeForm();
      this.notice.set({ level: 'success', message: t('ui.money.opened', { name: account.name }) });
      await this.load();
    } catch (e) {
      this.notice.set({ level: 'error', message: failureText(e) });
    } finally {
      this.busy.set(false);
    }
  }
}

/** The server's own message when it refused the request; otherwise the generic text. */
export function failureText(e: unknown): string {
  return e instanceof ApiError ? e.message : t('ui.common.somethingWentWrong');
}
