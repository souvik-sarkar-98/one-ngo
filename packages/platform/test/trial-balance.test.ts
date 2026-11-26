import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { fiscalYearBounds, fiscalYearKey } from '../src/shared/finance/fiscal-year.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { admin, createWorld, currentFiscalYear, expectCode, type TestWorld } from './helpers.js';

/** The trial balance on a date: balances carry forward, income restarts each year, and the two totals agree. */

let w: TestWorld;

const YEAR = currentFiscalYear();
const START = fiscalYearBounds(YEAR).startsOn;
const day = (n: number) => {
  const d = new Date(`${START}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const accountant: Actor = { id: 'accountant-1', roles: ['accountant'], permissions: ['ledger:read', 'money:accounts:read'] };
const reader: Actor = { id: 'reader-1', roles: ['reader'], permissions: ['money:accounts:read'] };

const post = (date: string, lines: { accountCode: string; debit?: number; credit?: number }[]) =>
  w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.post(asTx(tx), admin, { date, memo: 'Test entry', lines }));

const as = (who: Actor) => w.as(w.ngoA, who);
const byCode = (rows: { code: string; debit: string; credit: string }[]) => Object.fromEntries(rows.map((r) => [r.code, [r.debit, r.credit]]));

beforeAll(async () => {
  w = await createWorld();
  await w.platform.moneyAccounts.open(as(admin), { key: 'second', name: 'Project bank', kind: 'bank' });
  // Last year: 500.00 donated.
  await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.openFiscalYear(asTx(tx), admin, fiscalYearKey(day(-10))));
  await post(day(-10), [{ accountCode: 'BANK', debit: 500 }, { accountCode: 'DONATION_INCOME', credit: 500 }]);
  // This year: 1000.10 donated, 300.00 moved to the second bank, and a 50.00 slip reversed.
  await post(START, [{ accountCode: 'BANK', debit: 1000.1 }, { accountCode: 'DONATION_INCOME', credit: 1000.1 }]);
  await w.platform.moneyAccounts.transfer(as(admin), { from: 'upi', to: 'second', amount: 300, date: day(10) });
  const slip = await post(day(20), [{ accountCode: 'CASH', debit: 50 }, { accountCode: 'DONATION_INCOME', credit: 50 }]);
  await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.reverse(asTx(tx), admin, slip, day(21), 'wrong slip'));
});
afterAll(() => w.close());

describe('trial balance on a date', () => {
  it('carries money forward from earlier years but starts income again each year', async () => {
    const last = await w.platform.moneyAccounts.trialBalance(as(accountant), { asOf: day(-10) });
    expect(last.year.key).not.toBe(YEAR);
    expect(byCode(last.rows)).toEqual({ BANK: ['500.00', '0.00'], DONATION_INCOME: ['0.00', '500.00'] });
    expect(last).toMatchObject({ asOf: day(-10), totalDebit: '500.00', totalCredit: '500.00', balanced: true });

    const now = await w.platform.moneyAccounts.trialBalance(as(accountant), { asOf: day(5) });
    expect(now.year).toMatchObject({ key: YEAR, startsOn: START });
    // The bank holds last year's 500.00 as well; income shows only this year's 1000.10, and last year's result sits in one fund line.
    expect(byCode(now.rows)).toEqual({ BANK: ['1500.10', '0.00'], DONATION_INCOME: ['0.00', '1000.10'], SURPLUS_BF: ['0.00', '500.00'] });
  });

  it('adds up to equal totals to the paisa, with the result of earlier years rolled into one fund line', async () => {
    const res = await w.platform.moneyAccounts.trialBalance(as(accountant), { asOf: day(30) });
    expect(res.balanced).toBe(true);
    expect(res.totalDebit).toBe(res.totalCredit);
    expect(res.totalDebit).toBe('1500.10');
  });

  it('shows a transfer inside the money accounts and lets a reversal cancel the original', async () => {
    const res = await w.platform.moneyAccounts.trialBalance(as(accountant), { asOf: day(30) });
    const rows = byCode(res.rows);
    expect(res.rows.find((r) => r.moneyKey === 'second')).toMatchObject({ debit: '300.00', credit: '0.00' });
    expect(rows['BANK']).toEqual(['1200.10', '0.00']);
    expect(rows['CASH']).toBeUndefined();
    const withZero = await w.platform.moneyAccounts.trialBalance(as(accountant), { asOf: day(30), includeZero: true });
    expect(byCode(withZero.rows)['CASH']).toEqual(['0.00', '0.00']);
    expect(withZero.rows.length).toBeGreaterThan(res.rows.length);
    expect(withZero.totalDebit).toBe(res.totalDebit);
  });

  it('puts the money accounts total at the same figure as the money page for the same date', async () => {
    for (const asOf of [day(-10), day(5), day(15), day(30)]) {
      const tb = await w.platform.moneyAccounts.trialBalance(as(accountant), { asOf, includeZero: true });
      const money = await w.platform.moneyAccounts.balances(as(accountant), asOf);
      const cents = tb.rows.filter((r) => r.moneyKey).reduce((sum, r) => sum + Math.round((Number(r.debit) - Number(r.credit)) * 100), 0);
      expect((cents / 100).toFixed(2)).toBe(money.total);
    }
  });

  it('uses today when no date is given and refuses a date that is not one', async () => {
    expect((await w.platform.moneyAccounts.trialBalance(as(accountant))).asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expectCode(w.platform.moneyAccounts.trialBalance(as(accountant), { asOf: '31-03-2026' }), 'validation_failed');
    await expectCode(w.platform.moneyAccounts.trialBalance(as(accountant), { asOf: '2026-02-30' }), 'validation_failed');
  });

  it('is kept to those with the ledger permission, over HTTP too', async () => {
    await expectCode(w.platform.moneyAccounts.trialBalance(as(reader)), 'forbidden');
    const app = buildServer(w.platform, { devAuth: true });
    const get = (url: string, actor: Actor) => app.inject({ method: 'GET', url, headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) } });
    const ok = await get(`/api/ledger/trial-balance?asOf=${day(5)}`, accountant);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ asOf: day(5), balanced: true, totalDebit: '1500.10' });
    const zero = await get(`/api/ledger/trial-balance?asOf=${day(5)}&includeZero=true`, accountant);
    expect(zero.json().rows.length).toBeGreaterThan(ok.json().rows.length);
    expect((await get('/api/ledger/trial-balance', reader)).statusCode).toBe(403);
    expect((await get('/api/ledger/trial-balance?asOf=nope', accountant)).statusCode).toBe(422);
    const caps = async (actor: Actor) => (await get('/api/people/me', actor)).json().capabilities as Record<string, boolean>;
    expect(await caps(accountant)).toMatchObject({ ledger: true });
    expect(await caps(reader)).toMatchObject({ ledger: false });
    await app.close();
  });
});
