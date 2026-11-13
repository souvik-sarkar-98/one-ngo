import type { TenantContext } from '../ports/tenant-context.js';
import { notFound, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import { demand } from '../permissions.js';
import type { Tx, TransactionManager } from '../ports/transaction.js';
import type { LedgerService } from '../ledger/ledger-service.js';
import type { MoneyAccount, MoneyAccountKind, MoneyAccountStore } from './ports/money-account-store.js';
import { paiseToDecimal, toPaise } from '../money.js';

/** Setting key for allowed transfer pairs, e.g. [["bank","cash"],["cash","bank"]]. Absent means all pairs are allowed. */
export const TRANSFER_MATRIX_SETTING = 'money.transferMatrix';
export type { MoneyAccount, MoneyAccountKind } from './ports/money-account-store.js';

export interface OpenAccountInput {
  key: string;
  name: string;
  kind: MoneyAccountKind;
  holderUserId?: string;
  custodian?: string;
  upiId?: string;
  allowNegative?: boolean;
}

export interface TransferInput {
  from: string;
  to: string;
  amount: number | string;
  date: string;
  reference?: string;
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
      const code = `${input.kind.toUpperCase()}_${input.key.toUpperCase().replace(/-/g, '_')}`.slice(0, 31);
      const opened = await this.store.open(
        tx,
        ctx.actor.id,
        {
          key: input.key,
          name: input.name,
          kind: input.kind,
          ledgerCode: code,
          holderUserId: input.holderUserId ?? null,
          custodian: input.custodian ?? null,
          upiId: input.upiId ?? null,
          allowNegative: input.allowNegative ?? input.kind === 'bank',
        },
        input,
      );
      if (!opened) throw ruleViolation(`A ledger account '${code}' already exists.`);
      return this.byKey(tx, input.key);
    });
  }

  async list(ctx: TenantContext): Promise<MoneyAccount[]> {
    demand(ctx.actor, 'money:accounts:read');
    return this.transactions.withTenant(ctx.tenantId, (tx) => this.store.list(tx));
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
      if (!from.allowNegative && toPaise(from.balance) < paise) {
        throw ruleViolation(`${from.name} has only ${from.balance} available.`);
      }
      const journalEntryId = await this.ledger.post(tx, ctx.actor, {
        date: input.date,
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
