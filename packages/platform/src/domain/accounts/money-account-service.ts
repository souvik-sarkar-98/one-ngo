import type { TenantContext } from '../ports/tenant-context.js';
import { notFound, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import { demand } from '../permissions.js';
import type { Tx, TransactionManager } from '../ports/transaction.js';
import type { LedgerService, TrialBalance } from '../ledger/ledger-service.js';
import type {
  AccountBalance,
  LedgerAccountSummary,
  LedgerStatementPage,
  MoneyAccount,
  MoneyAccountChange,
  MoneyAccountKind,
  MoneyAccountStore,
} from './ports/money-account-store.js';
import { paiseToDecimal, toPaise } from '../money.js';
import { organisationToday } from '../../shared/time/organisation-time.js';

export type { AccountBalance, LedgerAccountSummary, LedgerLineKind, LedgerStatementLine } from './ports/money-account-store.js';

/** Lines of an account's ledger returned in one request. */
export const LEDGER_PAGE = 2000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, label: string): string {
  const ok = typeof value === 'string' && ISO_DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!ok) throw validationFailed(`${label} must be a date like 2026-04-30.`);
  return value;
}

export interface AccountBalances {
  asOf: string;
  total: string;
  accounts: AccountBalance[];
}

export interface LedgerQuery {
  from?: string;
  to?: string;
  limit?: number | string;
  offset?: number | string;
}

export interface AccountLedger extends LedgerStatementPage {
  account: { key: string; name: string; kind: MoneyAccountKind; ledgerCode: string; status: 'active' | 'closed' };
  from: string;
  to: string;
  offset: number;
  limit: number;
}

/** Setting key for allowed transfer pairs, e.g. [["bank","cash"],["cash","bank"]]. Absent means all pairs are allowed. */
export const TRANSFER_MATRIX_SETTING = 'money.transferMatrix';
export type { MoneyAccount, MoneyAccountKind } from './ports/money-account-store.js';

export interface OpenAccountInput {
  key: string;
  name: string;
  kind: MoneyAccountKind;
  /** An existing asset ledger account to attach to (for example BANK). Omit to create a new one. */
  ledgerCode?: string;
  holderUserId?: string;
  custodian?: string;
  upiId?: string;
  allowNegative?: boolean;
}

export interface UpdateAccountInput {
  name?: string | null;
  custodian?: string | null;
  /** An empty text or null clears the UPI ID. */
  upiId?: string | null;
  allowNegative?: boolean | null;
}

export interface TransferInput {
  from: string;
  to: string;
  amount: number | string;
  date: string;
  reference?: string;
  /** Why the sending account may go below zero although it does not allow that. Kept on the audit trail. */
  overrideReason?: string;
}

/**
 * Wallets, bank, cash, and investment accounts. Each has its own ledger
 * account; balances come from posted journal lines; transfers are journal
 * entries and never count as income or expenditure.
 */
export class MoneyAccountService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: MoneyAccountStore,
    private readonly ledger: LedgerService,
  ) {}

  async open(ctx: TenantContext, input: OpenAccountInput): Promise<MoneyAccount> {
    demand(ctx.actor, 'money:accounts:manage');
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(input.key)) throw validationFailed('Account key must be lowercase letters, digits, or -.');
    if (input.upiId && !/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/.test(input.upiId)) throw validationFailed('Enter a valid UPI ID.');
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      if (await this.store.byKey(tx, input.key)) throw ruleViolation(`A money account '${input.key}' already exists.`);
      let code = `${input.kind.toUpperCase()}_${input.key.toUpperCase().replace(/-/g, '_')}`.slice(0, 31);
      let ledgerAccountId: string | undefined;
      if (input.ledgerCode) {
        // Attach to the books' existing account, so the real account and its ledger balance are one thing.
        code = input.ledgerCode;
        const ledger = await this.store.ledgerAccount(tx, code);
        if (!ledger) throw ruleViolation(`There is no ledger account '${code}' to attach to.`);
        if (ledger.type !== 'asset') throw ruleViolation(`'${code}' is not an asset account, so it cannot hold money.`);
        if (!ledger.active) throw ruleViolation(`'${code}' is closed.`);
        if (ledger.linked) throw ruleViolation(`'${code}' already belongs to another money account.`);
        ledgerAccountId = ledger.id;
      }
      const opened = await this.store.open(
        tx,
        ctx.actor.id,
        {
          key: input.key,
          name: input.name,
          kind: input.kind,
          ledgerCode: code,
          ledgerAccountId,
          holderUserId: input.holderUserId ?? null,
          custodian: input.custodian ?? null,
          upiId: input.upiId ?? null,
          allowNegative: input.allowNegative ?? false,
        },
        input,
      );
      if (!opened) throw ruleViolation(`A ledger account '${code}' already exists.`);
      return this.byKey(tx, input.key);
    });
  }

  /** Changes the name, UPI ID, custodian or overdraft rule of an active account. The key, kind and ledger account stay. */
  async update(ctx: TenantContext, key: string, input: UpdateAccountInput): Promise<MoneyAccount> {
    demand(ctx.actor, 'money:accounts:manage');
    // A missing field stays as it is. An empty or null UPI ID or custodian clears it; a name cannot be empty.
    const name = input.name == null ? undefined : input.name.trim();
    if (name !== undefined && !name) throw validationFailed('An account needs a name.');
    const upiId = input.upiId === undefined ? undefined : (input.upiId ?? '').trim() || null;
    if (upiId && !/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/.test(upiId)) throw validationFailed('Enter a valid UPI ID.');
    const custodian = input.custodian === undefined ? undefined : (input.custodian ?? '').trim() || null;
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.byKey(tx, key);
      if (before.status !== 'active') throw ruleViolation('A closed account cannot be changed.');
      if (input.allowNegative === false && toPaise(before.balance) < 0) {
        throw ruleViolation(`${before.name} is below zero now. Bring it back to zero before turning the overdraft off.`);
      }
      const change: MoneyAccountChange = {
        ...(name !== undefined && { name }),
        ...(custodian !== undefined && { custodian }),
        ...(upiId !== undefined && { upiId }),
        ...(input.allowNegative != null && { allowNegative: input.allowNegative }),
      };
      if (Object.keys(change).length) {
        await this.store.update(tx, ctx.actor.id, key, change, {
          before: { name: before.name, custodian: before.custodian, upiId: before.upiId, allowNegative: before.allowNegative },
          after: change,
        });
      }
      return this.byKey(tx, key);
    });
  }

  async list(ctx: TenantContext): Promise<MoneyAccount[]> {
    demand(ctx.actor, 'money:accounts:read');
    return this.transactions.withTenant(ctx.tenantId, (tx) => this.store.list(tx));
  }

  /** What each active account holds on a date (today when none is given), and the total of them. */
  async balances(ctx: TenantContext, asOfInput?: string): Promise<AccountBalances> {
    demand(ctx.actor, 'money:accounts:read');
    const asOf = asOfInput ? checkDate(asOfInput, 'As-on date') : organisationToday();
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const accounts = await this.store.balancesAsOf(tx, asOf);
      return { asOf, total: paiseToDecimal(accounts.reduce((sum, a) => sum + toPaise(a.balance), 0)), accounts };
    });
  }

  /**
   * Every entry on the account between two dates, oldest first, with a running balance, the opening and
   * closing balance, and what each entry came from. The range is the current financial year unless given.
   */
  async accountLedger(ctx: TenantContext, key: string, query: LedgerQuery = {}): Promise<AccountLedger> {
    demand(ctx.actor, 'money:accounts:read');
    const limit = Math.min(Math.max(Math.trunc(Number(query.limit ?? LEDGER_PAGE)) || LEDGER_PAGE, 1), LEDGER_PAGE);
    const offset = Math.max(Math.trunc(Number(query.offset ?? 0)) || 0, 0);
    if (query.from) checkDate(query.from, 'From date');
    if (query.to) checkDate(query.to, 'To date');
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const account = await this.byKey(tx, key);
      const year = await this.ledger.fiscalYearOf(tx, organisationToday());
      const from = query.from ?? year.startsOn;
      const to = query.to ?? year.endsOn;
      if (from > to) throw validationFailed('The from date is after the to date.');
      const page = await this.store.ledgerStatement(tx, key, { from, to }, { limit, offset });
      return {
        account: { key: account.key, name: account.name, kind: account.kind, ledgerCode: account.ledgerCode, status: account.status },
        from,
        to,
        offset,
        limit,
        ...page,
      };
    });
  }

  /** Every ledger account's balance on a date (today when none is given), in Debit and Credit columns that add up to the same total. */
  async trialBalance(ctx: TenantContext, query: { asOf?: string; includeZero?: string | boolean } = {}): Promise<TrialBalance> {
    demand(ctx.actor, 'ledger:read');
    const includeZero = query.includeZero === true || query.includeZero === 'true' || query.includeZero === '1';
    return this.transactions.withTenant(ctx.tenantId, (tx) => this.ledger.trialBalanceAsOn(tx, query.asOf || organisationToday(), { includeZero }), { readOnly: true });
  }

  /** Every ledger account, so a bank line can be booked against the other side. */
  async ledgerAccounts(ctx: TenantContext): Promise<LedgerAccountSummary[]> {
    demand(ctx.actor, 'money:reconcile');
    return this.transactions.withTenant(ctx.tenantId, (tx) => this.store.ledgerAccounts(tx));
  }

  async get(ctx: TenantContext, key: string): Promise<MoneyAccount> {
    demand(ctx.actor, 'money:accounts:read');
    return this.transactions.withTenant(ctx.tenantId, (tx) => this.byKey(tx, key));
  }

  async transfer(ctx: TenantContext, input: TransferInput): Promise<{ transferId: string; journalEntryId: string }> {
    demand(ctx.actor, 'money:transfer');
    const paise = toPaise(input.amount, 'Transfer amount');
    if (paise <= 0) throw ruleViolation('Transfer amount must be more than zero.');
    if (input.from === input.to) throw ruleViolation('Choose two different accounts.');
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      // Lock both accounts in a stable order so concurrent transfers cannot overdraw.
      if ((await this.store.lock(tx, [input.from, input.to])) !== 2) throw notFound('Account not found.');
      const from = await this.byKey(tx, input.from);
      const to = await this.byKey(tx, input.to);
      if (from.status !== 'active' || to.status !== 'active') throw ruleViolation('Closed accounts cannot be used.');
      await this.checkMatrix(tx, from.kind, to.kind);
      const reason = input.overrideReason?.trim();
      if (!from.allowNegative && toPaise(from.balance) < paise && !reason) {
        throw ruleViolation(`${from.name} has only ${from.balance} available.`);
      }
      const journalEntryId = await this.ledger.post(tx, ctx.actor, {
        date: input.date,
        overdraftReason: reason,
        memo: `Transfer ${from.name} to ${to.name}${input.reference ? ` (${input.reference})` : ''}`,
        lines: [
          { accountCode: to.ledgerCode, debit: paiseToDecimal(paise) },
          { accountCode: from.ledgerCode, credit: paiseToDecimal(paise) },
        ],
      });
      const transferId = await this.store.recordTransfer(
        tx,
        ctx.actor.id,
        {
          fromAccountId: from.id,
          toAccountId: to.id,
          amount: paiseToDecimal(paise),
          date: input.date,
          reference: input.reference ?? null,
          journalEntryId,
        },
        { from: from.key, to: to.key },
      );
      return { transferId, journalEntryId };
    });
  }

  async close(ctx: TenantContext, key: string): Promise<void> {
    demand(ctx.actor, 'money:accounts:manage');
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const account = await this.byKey(tx, key);
      if (toPaise(account.balance) !== 0) throw ruleViolation('Move the remaining balance before closing this account.');
      await this.store.close(tx, ctx.actor.id, key, account.ledgerCode);
    });
  }

  private async byKey(tx: Tx, key: string): Promise<MoneyAccount> {
    const account = await this.store.byKey(tx, key);
    if (!account) throw notFound(`Account '${key}' not found.`);
    return account;
  }

  private async checkMatrix(tx: Tx, from: MoneyAccountKind, to: MoneyAccountKind): Promise<void> {
    const matrix = await this.store.transferMatrix(tx, TRANSFER_MATRIX_SETTING);
    if (!matrix) return;
    if (!matrix.some(([f, t]) => f === from && t === to)) {
      throw ruleViolation(`Transfers from ${from} to ${to} accounts are not allowed.`);
    }
  }
}
