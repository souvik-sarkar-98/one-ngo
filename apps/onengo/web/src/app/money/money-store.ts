import { Injectable, computed, inject, signal } from '@angular/core';
import { MONEY_KINDS, editAccountValues, kindLabel, moneyColumns, moneyRow, openAccountDefaults, validateEditAccount, validateOpenAccount, type MoneyAccount } from '../core/money/money';
import { t } from '../core/i18n/i18n';
import type { FormValues } from '../core/records/record/forms';
import type { Notice } from '../records/notice';
import { Api, ApiError } from '../services/api';
import { I18n } from '../services/i18n';
import { Session } from '../services/session';
import type { CfFieldDef } from '../ui/cf-types';
import { Viewport } from '../ui/viewport';

/** The money page: every account with its ledger balance, and opening a new one for people who may manage accounts. */
@Injectable()
export class MoneyStore {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  private readonly session = inject(Session);
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
  readonly rows = computed(() => {
    this.i18n.locale();
    const canManage = this.canManage();
    return this.accounts().map(moneyRow).map((row) => (canManage ? row : { ...row, actions: [] }));
  });
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

  /** A row's menu: Edit opens the form on that account. */
  rowAction(id: string, action: string): void {
    const account = this.accounts().find((a) => a.id === id);
    if (action !== 'edit' || !account || !this.canManage()) return;
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
