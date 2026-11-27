import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { fiscalYearBounds } from '../../../packages/platform/src/shared/finance/fiscal-year.js';
import { asTx } from '../../../packages/platform/src/infrastructure/postgres/tx.js';
import type { Actor } from '../../../packages/platform/src/infrastructure/postgres/db.js';
import { admin, createWorld, currentFiscalYear, expectCode, type TestWorld } from '../../support/platform/helpers.js';

/** The reads behind the Money screens: balances on a date, an account's ledger, the lines open for pairing, and the ledger accounts. */

let w: TestWorld;
let donation: { id: string; number: string | null };

const START = fiscalYearBounds(currentFiscalYear()).startsOn;
const END = fiscalYearBounds(currentFiscalYear()).endsOn;
const day = (n: number) => {
  const d = new Date(`${START}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const treasurer: Actor = { id: 'treasurer-1', roles: ['treasurer'], permissions: ['money:accounts:read', 'money:transfer', 'money:reconcile'] };
const reader: Actor = { id: 'reader-1', roles: ['reader'], permissions: ['money:accounts:read'] };
const outsider: Actor = { id: 'outsider-1', roles: [], permissions: ['record:donation:read'] };

const post = (date: string, lines: { accountCode: string; debit?: number; credit?: number }[], sourceRecordId?: string) =>
  w.platform.db.withTenant(w.ngoA, (tx) =>
    w.platform.ledger.post(asTx(tx), admin, { date, memo: 'Test entry', lines, ...(sourceRecordId && { sourceRecordId, sourceRule: 'test' }) }),
  );

beforeAll(async () => {
  w = await createWorld();
  const ctx = w.as(w.ngoA);
  await w.platform.moneyAccounts.open(ctx, { key: 'second', name: 'Project bank', kind: 'bank' });
  const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Asha Verma', amount: 1000 });
  donation = { id: record.id, number: record.number };
  await post(START, [{ accountCode: 'BANK', debit: 1000 }, { accountCode: 'DONATION_INCOME', credit: 1000 }], donation.id);
  await w.platform.moneyAccounts.transfer(ctx, { from: 'upi', to: 'second', amount: 300, date: day(10) });
  const duplicate = await post(day(20), [{ accountCode: 'BANK', debit: 50 }, { accountCode: 'DONATION_INCOME', credit: 50 }]);
  await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.reverse(asTx(tx), admin, duplicate, day(21), 'duplicate entry'));
});
afterAll(() => w.close());

const as = (who: Actor) => w.as(w.ngoA, who);

describe('balances on a date', () => {
  it('shows each active account as it stood, and the total', async () => {
    const at = async (asOf: string) => {
      const res = await w.platform.moneyAccounts.balances(as(reader), asOf);
      return { asOf: res.asOf, total: res.total, balances: Object.fromEntries(res.accounts.map((a) => [a.key, a.balance])) };
    };
    expect(await at(day(-1))).toEqual({ asOf: day(-1), total: '0.00', balances: { upi: '0.00', second: '0.00', cash: '0.00' } });
    expect(await at(START)).toEqual({ asOf: START, total: '1000.00', balances: { upi: '1000.00', second: '0.00', cash: '0.00' } });
    expect(await at(day(10))).toEqual({ asOf: day(10), total: '1000.00', balances: { upi: '700.00', second: '300.00', cash: '0.00' } });
    expect(await at(day(25))).toMatchObject({ total: '1000.00', balances: { upi: '700.00', second: '300.00', cash: '0.00' } });
  });

  it('names the account, its kind and its ledger code, and leaves out a closed account', async () => {
    await w.platform.moneyAccounts.open(as(admin), { key: 'scratch', name: 'Scratch', kind: 'wallet' });
    expect((await w.platform.moneyAccounts.balances(as(reader), day(30))).accounts.map((a) => a.key)).toContain('scratch');
    await w.platform.moneyAccounts.close(as(admin), 'scratch');
    const res = await w.platform.moneyAccounts.balances(as(reader), day(30));
    expect(res.accounts.map((a) => a.key)).toEqual(['upi', 'second', 'cash']);
    expect(res.accounts[0]).toEqual({ key: 'upi', name: 'Main bank account', kind: 'bank', ledgerCode: 'BANK', balance: '700.00' });
  });

  it('uses today when no date is given, and refuses a date that is not one', async () => {
    expect((await w.platform.moneyAccounts.balances(as(reader))).asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expectCode(w.platform.moneyAccounts.balances(as(reader), '31-03-2026'), 'validation_failed');
    await expectCode(w.platform.moneyAccounts.balances(as(reader), '2026-02-30'), 'validation_failed');
  });
});

describe('an account ledger', () => {
  it('lists every entry with a running balance, where it came from, and the opening and closing balance', async () => {
    const res = await w.platform.moneyAccounts.accountLedger(as(reader), 'upi', { from: START, to: day(30) });
    expect(res).toMatchObject({
      account: { key: 'upi', name: 'Main bank account', kind: 'bank', ledgerCode: 'BANK', status: 'active' },
      from: START,
      to: day(30),
      opening: '0.00',
      totalIn: '1050.00',
      totalOut: '350.00',
      closing: '700.00',
      count: 4,
      offset: 0,
    });
    expect(res.lines.map((l) => [l.date, l.debit, l.credit, l.balance, l.kind, l.reversed])).toEqual([
      [START, '1000.00', '0.00', '1000.00', 'record', false],
      [day(10), '0.00', '300.00', '700.00', 'transfer', false],
      [day(20), '50.00', '0.00', '750.00', 'manual', true],
      [day(21), '0.00', '50.00', '700.00', 'reversal', false],
    ]);
    expect(res.lines[0]).toMatchObject({ sourceRecordId: donation.id, sourceRecordType: 'donation', sourceRecordNumber: donation.number, memo: 'Test entry' });
    expect(res.lines[1]).toMatchObject({ sourceRecordId: null, memo: expect.stringContaining('Transfer') });
    expect(res.lines[3]!.memo).toContain('Reversal');
  });

  it('starts from the balance before the first date', async () => {
    const res = await w.platform.moneyAccounts.accountLedger(as(reader), 'upi', { from: day(5), to: day(30) });
    expect(res).toMatchObject({ opening: '1000.00', totalIn: '50.00', totalOut: '350.00', closing: '700.00', count: 3 });
    expect(res.lines[0]).toMatchObject({ date: day(10), balance: '700.00' });
    const empty = await w.platform.moneyAccounts.accountLedger(as(reader), 'upi', { from: day(40), to: day(50) });
    expect(empty).toMatchObject({ opening: '700.00', closing: '700.00', totalIn: '0.00', totalOut: '0.00', count: 0, lines: [] });
  });

  it('pages, keeping the running balance right across pages', async () => {
    const first = await w.platform.moneyAccounts.accountLedger(as(reader), 'upi', { from: START, to: day(30), limit: 2 });
    const second = await w.platform.moneyAccounts.accountLedger(as(reader), 'upi', { from: START, to: day(30), limit: 2, offset: 2 });
    expect(first).toMatchObject({ count: 4, limit: 2, offset: 0 });
    expect([...first.lines, ...second.lines].map((l) => l.balance)).toEqual(['1000.00', '700.00', '750.00', '700.00']);
    expect(second.offset).toBe(2);
  });

  it('defaults to the current financial year, and refuses a bad range or an unknown account', async () => {
    const res = await w.platform.moneyAccounts.accountLedger(as(reader), 'second');
    expect(res).toMatchObject({ from: START, to: END, opening: '0.00', closing: '300.00', count: 1 });
    expect(res.lines[0]).toMatchObject({ debit: '300.00', kind: 'transfer' });
    await expectCode(w.platform.moneyAccounts.accountLedger(as(reader), 'upi', { from: day(30), to: day(1) }), 'validation_failed');
    await expectCode(w.platform.moneyAccounts.accountLedger(as(reader), 'upi', { from: 'yesterday' }), 'validation_failed');
    await expectCode(w.platform.moneyAccounts.accountLedger(as(reader), 'nobody'), 'not_found');
  });
});

describe('lines open for pairing, and ledger accounts', () => {
  it('lists the entries no statement line has taken, and drops one once a statement line takes it', async () => {
    const all = await w.platform.bankReconciliation.bookLines(as(treasurer), 'upi');
    expect(all.map((l) => [l.date, l.amount])).toEqual([[START, '1000.00'], [day(10), '-300.00'], [day(20), '50.00'], [day(21), '-50.00']]);
    expect((await w.platform.bankReconciliation.bookLines(as(treasurer), 'upi', { from: day(10), to: day(20) })).map((l) => l.amount)).toEqual(['-300.00', '50.00']);
    await w.platform.bankReconciliation.importStatement(as(treasurer), 'upi', [{ date: START, amount: 1000, description: 'Deposit' }]);
    expect((await w.platform.bankReconciliation.bookLines(as(treasurer), 'upi')).map((l) => l.amount)).toEqual(['-300.00', '50.00', '-50.00']);
    await expectCode(w.platform.bankReconciliation.bookLines(as(treasurer), 'upi', { from: day(5), to: day(1) }), 'validation_failed');
    await expectCode(w.platform.bankReconciliation.bookLines(as(treasurer), 'nobody'), 'not_found');
  });

  it('lists every ledger account, saying which is a money account', async () => {
    const accounts = await w.platform.moneyAccounts.ledgerAccounts(as(treasurer));
    const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));
    expect(byCode['BANK']).toMatchObject({ name: 'Bank account', type: 'asset', active: true, moneyKey: 'upi' });
    expect(byCode['CASH']).toMatchObject({ type: 'asset', moneyKey: 'cash' });
    expect(byCode['DONATION_INCOME']).toMatchObject({ type: 'income', moneyKey: null });
    expect(Object.values(byCode).find((a) => a.moneyKey === 'second')).toMatchObject({ type: 'asset' });
    expect(accounts.map((a) => a.code)).toEqual([...accounts.map((a) => a.code)].sort());
  });
});

describe('who may use them', () => {
  it('keeps balances and ledgers to those who read money accounts, and pairing data to those who reconcile', async () => {
    await expectCode(w.platform.moneyAccounts.balances(as(outsider)), 'forbidden');
    await expectCode(w.platform.moneyAccounts.accountLedger(as(outsider), 'upi'), 'forbidden');
    await expectCode(w.platform.moneyAccounts.ledgerAccounts(as(reader)), 'forbidden');
    await expectCode(w.platform.bankReconciliation.bookLines(as(reader), 'upi'), 'forbidden');
  });

  it('serves them over HTTP, with the same checks, and reports who may reconcile and transfer', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const get = (url: string, actor: Actor) => app.inject({ method: 'GET', url, headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) } });

    const balances = await get(`/api/money/balances?asOf=${day(10)}`, reader);
    expect(balances.statusCode).toBe(200);
    expect(balances.json()).toMatchObject({ asOf: day(10), total: '1000.00', accounts: [{ key: 'upi', balance: '700.00' }, { key: 'second', balance: '300.00' }, { key: 'cash', balance: '0.00' }] });

    const ledger = await get(`/api/money/accounts/upi/ledger?from=${START}&to=${day(30)}&limit=2&offset=2`, reader);
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()).toMatchObject({ count: 4, limit: 2, offset: 2, closing: '700.00' });
    expect(ledger.json().lines).toHaveLength(2);
    expect((await get('/api/money/accounts/upi/ledger?from=bad', reader)).statusCode).toBe(422);
    expect((await get('/api/money/accounts/nobody/ledger', reader)).statusCode).toBe(404);

    expect((await get('/api/money/balances', outsider)).statusCode).toBe(403);
    expect((await get('/api/money/accounts/upi/ledger', outsider)).statusCode).toBe(403);
    expect((await get('/api/money/accounts/upi/book-lines', reader)).statusCode).toBe(403);
    expect((await get('/api/ledger/accounts', reader)).statusCode).toBe(403);
    const lines = await get('/api/money/accounts/upi/book-lines?from=' + day(10), treasurer);
    expect(lines.statusCode).toBe(200);
    expect(lines.json()).toHaveLength(3);
    const accounts = await get('/api/ledger/accounts', treasurer);
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().map((a: { code: string }) => a.code)).toContain('BANK');

    const caps = async (actor: Actor) => (await get('/api/people/me', actor)).json().capabilities as Record<string, boolean>;
    expect(await caps(treasurer)).toMatchObject({ money: true, moneyReconcile: true, moneyTransfer: true });
    expect(await caps(reader)).toMatchObject({ money: true, moneyReconcile: false, moneyTransfer: false });
    expect(await caps(outsider)).toMatchObject({ money: false, moneyReconcile: false, moneyTransfer: false });
    await app.close();
  });
});
