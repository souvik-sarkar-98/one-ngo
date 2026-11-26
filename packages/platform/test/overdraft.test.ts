import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asTx } from '../src/infrastructure/postgres/tx.js';
import { admin, createWorld, expectCode, today, type TestWorld } from './helpers.js';

/** A bank, cash or wallet account that does not allow an overdraft cannot be taken below zero without a reason, and the reason is kept. */

let w: TestWorld;

const post = (lines: { accountCode: string; debit?: number; credit?: number }[], overdraftReason?: string) =>
  w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.post(asTx(tx), admin, { date: today(), memo: 'Test entry', overdraftReason, lines }));

const pay = (amount: number, overdraftReason?: string) => post([{ accountCode: 'BANK', credit: amount }, { accountCode: 'EXP_OTHER', debit: amount }], overdraftReason);
const deposit = (amount: number) => post([{ accountCode: 'BANK', debit: amount }, { accountCode: 'DONATION_INCOME', credit: amount }]);
const bank = async () => Number((await w.platform.moneyAccounts.get(w.as(w.ngoA), 'upi')).balance);
const entries = () => w.platform.db.withTenant(w.ngoA, async (tx) => Number((await tx.query<{ n: string }>(`select count(*)::text as n from journal_entry`))[0]!.n));
const overrides = () =>
  w.platform.db.withTenant(w.ngoA, (tx) =>
    tx.query<{ entity_id: string; after: { reason: string; accounts: { code: string; before: string; after: string }[] } }>(
      `select entity_id, after from audit_event where action = 'ledger.overdraft_override' order by at`,
    ),
  );

beforeAll(async () => {
  w = await createWorld();
  await w.platform.db.withTenant(w.ngoA, (tx) =>
    tx.query(`insert into ledger_account (tenant_id, code, name, type) values (app_tenant(), 'EXP_OTHER', 'Other expenses', 'expense') on conflict do nothing`),
  );
  await deposit(100);
});
afterAll(() => w.close());

describe('posting to a money account that does not allow an overdraft', () => {
  it('is refused when it takes the account below zero, and nothing is posted', async () => {
    const before = await entries();
    const err = await expectCode(pay(150), 'validation_failed');
    expect((err as Error & { issues?: unknown }).issues).toEqual([expect.objectContaining({ path: '/overdraftReason', message: expect.stringContaining('100.00') })]);
    await expectCode(pay(150, '   '), 'validation_failed');
    expect(await entries()).toBe(before);
    expect(await bank()).toBe(100);
  });

  it('lets money out up to what the account holds, down to exactly zero', async () => {
    await pay(40);
    expect(await bank()).toBe(60);
    await pay(60);
    expect(await bank()).toBe(0);
    await deposit(100);
  });

  it('goes through with a reason, which is kept on the audit trail with the accounts and what they held', async () => {
    const id = await pay(130, 'Cheque cleared before the deposit reached us');
    expect(await bank()).toBe(-30);
    const kept = (await overrides()).find((o) => o.entity_id === id)!;
    expect(kept.after).toEqual({ reason: 'Cheque cleared before the deposit reached us', accounts: [{ code: 'BANK', before: '100.00', after: '-30.00' }] });
    await deposit(130);
  });

  it('leaves the other accounts alone: money in, income and expense accounts, and accounts that allow an overdraft', async () => {
    await deposit(10);
    await post([{ accountCode: 'EXP_OTHER', credit: 5 }, { accountCode: 'DONATION_INCOME', debit: 5 }]);
    await w.platform.moneyAccounts.update(w.as(w.ngoA), 'upi', { allowNegative: true });
    const count = (await overrides()).length;
    await pay(1000);
    expect(await bank()).toBeLessThan(0);
    expect((await overrides()).length).toBe(count);
    await deposit(Math.abs(await bank()) + 100);
    await w.platform.moneyAccounts.update(w.as(w.ngoA), 'upi', { allowNegative: false });
  });

  it('counts only what the entry takes out: a move between two accounts nets out on the one account', async () => {
    await deposit(2000);
    const level = await bank();
    await post([{ accountCode: 'BANK', credit: 50 }, { accountCode: 'BANK', debit: 50 }, { accountCode: 'EXP_OTHER', debit: 1 }, { accountCode: 'DONATION_INCOME', credit: 1 }]);
    expect(await bank()).toBe(level);
  });
});

describe('two payments at the same time', () => {
  it('cannot both spend the same money', async () => {
    const level = await bank();
    expect(level).toBeGreaterThan(0);
    const each = Math.floor(level * 0.6);
    const results = await Promise.allSettled([pay(each), pay(each)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await bank()).toBe(level - each);
  });
});

describe('reversing an entry', () => {
  it('is never held back by the overdraft rule, and the reason it gives is kept', async () => {
    const level = await bank();
    const id = await deposit(500);
    await pay(level + 500);
    expect(await bank()).toBe(0);
    await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.reverse(asTx(tx), admin, id, today(), 'Entered twice'));
    expect(await bank()).toBe(-500);
    const last = (await overrides()).at(-1)!;
    expect(last.after.reason).toBe('Reversal: Entered twice');
  });
});

describe('a transfer', () => {
  it('needs a reason to take the sending account below zero, and keeps it', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.moneyAccounts.open(ctx, { key: 'second', name: 'Project bank', kind: 'bank' });
    await w.platform.moneyAccounts.open(ctx, { key: 'wallet', name: 'Wallet', kind: 'wallet' });
    await deposit(1000);
    const level = await bank();
    await expectCode(w.platform.moneyAccounts.transfer(ctx, { from: 'second', to: 'upi', amount: 10, date: today() }), 'rule_violation');
    await expectCode(w.platform.moneyAccounts.transfer(ctx, { from: 'second', to: 'upi', amount: 10, date: today(), overrideReason: '   ' }), 'rule_violation');
    const { journalEntryId } = await w.platform.moneyAccounts.transfer(ctx, { from: 'second', to: 'upi', amount: 10, date: today(), overrideReason: 'Grant arrives tomorrow' });
    expect(await bank()).toBe(level + 10);
    expect((await w.platform.moneyAccounts.get(ctx, 'second')).balance).toBe('-10.00');
    expect((await overrides()).find((o) => o.entity_id === journalEntryId)!.after).toEqual({ reason: 'Grant arrives tomorrow', accounts: [{ code: 'BANK_SECOND', before: '0.00', after: '-10.00' }] });
    // A reason does not matter when the account has the money.
    const before = (await overrides()).length;
    await w.platform.moneyAccounts.transfer(ctx, { from: 'upi', to: 'wallet', amount: 5, date: today(), overrideReason: 'Not needed' });
    expect((await overrides()).length).toBe(before);
  });
});
