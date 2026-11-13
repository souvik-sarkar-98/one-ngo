import { expect } from 'vitest';
import type { TenantContext } from '../postgres/db.js';
import type { NewReceipt } from '../../domain/receipts/ports/receipt-store.js';
import type { Tx } from '../../domain/ports/transaction.js';
import type { NewRecord } from '../../runtime/records/ports/record-store.js';
import type { ProviderWorld, Refusal } from './provider.js';

export type World = () => ProviderWorld;

export const ACTOR = 'contract-admin';

export const ctxOf = (tenantId: string): TenantContext => ({ tenantId, actor: { id: ACTOR, roles: ['admin'], permissions: ['*'] } });

export function newRecord(typeKey: string, data: Record<string, unknown> = {}, more: Partial<NewRecord> = {}): NewRecord {
  return {
    typeKey,
    number: null,
    workflowKey: null,
    status: 'draft',
    schemaVersion: 1,
    data,
    index: {},
    states: {},
    searchText: '',
    actorId: ACTOR,
    ...more,
  };
}

/** The promise fails, and the provider names `why` as the database's reason. */
export async function expectRefused(world: ProviderWorld, promise: Promise<unknown>, why: Refusal): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e ?? new Error('rejected without a reason'),
  );
  expect(error, `expected the database to refuse (${why})`).toBeDefined();
  expect(world.refusal(error)).toBe(why);
}

export const PERIOD = { key: '2030-31', startsOn: '2030-04-01', endsOn: '2031-03-31' };
export const IN_PERIOD = '2030-06-15';

/** Accounts 1000 (bank), 4000 (income), receipt series `donation`, and the open period `PERIOD`. */
export async function setUpFinance(world: ProviderWorld, tenantId: string): Promise<{ bank: string; income: string; periodId: string }> {
  const { definitions, ledger } = world.stores;
  return world.transactions.withTenant(tenantId, async (tx) => {
    await definitions.installModule(tx, {
      key: 'contract-finance',
      version: '1.0.0',
      setup: {
        accounts: [
          { code: '1000', name: 'Bank', type: 'asset' },
          { code: '4000', name: 'Donations', type: 'income' },
        ],
        receiptSeries: [{ key: 'donation', prefix: 'DR-', label: 'Donation receipts' }],
      },
    });
    await ledger.openPeriod(tx, ACTOR, PERIOD);
    const accounts = await ledger.accounts(tx, ['1000', '4000']);
    const period = await ledger.period(tx, PERIOD.key);
    return { bank: accounts.find((a) => a.code === '1000')!.id, income: accounts.find((a) => a.code === '4000')!.id, periodId: period!.id };
  });
}

export function balanced(periodId: string, bank: string, income: string, amount: string, more: { sourceRecordId?: string; sourceRule?: string; reversesEntryId?: string } = {}) {
  return {
    periodId,
    date: IN_PERIOD,
    memo: null,
    sourceRecordId: more.sourceRecordId ?? null,
    sourceRule: more.sourceRule ?? null,
    reversesEntryId: more.reversesEntryId ?? null,
    lines: [
      { accountId: bank, debit: amount, credit: '0', fund: null },
      { accountId: income, debit: '0', credit: amount, fund: null },
    ],
    total: amount,
  };
}

export const ISSUER: NewReceipt['issuer'] = {
  displayName: 'Contract Trust',
  legalName: null,
  contact: { email: null, phone: null, website: null },
  address: null,
  registrations: [],
  logo: null,
};

/** Takes the next number of the `donation` series and issues a receipt with it. */
export async function issueReceipt(world: ProviderWorld, tx: Tx, amount: string, recordId: string | null, replacesReceiptId: string | null = null) {
  const { receipts } = world.stores;
  const seq = await receipts.nextNumber(tx, 'receipt:donation', PERIOD.key);
  return receipts.insert(tx, ACTOR, {
    seriesKey: 'donation',
    period: PERIOD.key,
    seq,
    number: `DR-${PERIOD.key}-${seq}`,
    recordId,
    amount,
    date: IN_PERIOD,
    replacesReceiptId,
    issuer: ISSUER,
  });
}

/** A promise and the function that settles it, for holding a transaction or a job open. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
