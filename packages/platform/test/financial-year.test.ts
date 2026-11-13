import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { typed } from '../src/infrastructure/postgres/kysely.js';
import { fiscalYearBounds, fiscalYearKey, isFiscalYearKey } from '../src/domain/ledger/fiscal-year.js';
import { admin, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

describe('financial year labels and bounds', () => {
  it('labels April years 2026-27, January years 2026, and other months by the year they start', () => {
    expect(fiscalYearKey('2026-10-18')).toBe('2026-27');
    expect(fiscalYearKey('2027-03-31')).toBe('2026-27');
    expect(fiscalYearKey('2027-04-01')).toBe('2027-28');
    expect(fiscalYearKey('2026-12-31', 1)).toBe('2026');
    expect(fiscalYearKey('2027-01-01', 1)).toBe('2027');
    expect(fiscalYearKey('2026-06-30', 7)).toBe('2025-26');
    expect(fiscalYearKey('2099-12-31', 12)).toBe('2099-00');
    expect(fiscalYearBounds('2026-27')).toEqual({ startsOn: '2026-04-01', endsOn: '2027-03-31' });
    expect(fiscalYearBounds('2026', 1)).toEqual({ startsOn: '2026-01-01', endsOn: '2026-12-31' });
    expect(fiscalYearBounds('2027-28', 3)).toEqual({ startsOn: '2027-03-01', endsOn: '2028-02-29' });
    expect(isFiscalYearKey('2026-27')).toBe(true);
    expect(isFiscalYearKey('2026-28')).toBe(false);
    expect(isFiscalYearKey('2026', 4)).toBe(false);
    expect(isFiscalYearKey('2026', 1)).toBe(true);
    expect(isFiscalYearKey('2026-27', 1)).toBe(false);
  });

  it('keeps the label and the bounds consistent for every start month', () => {
    for (let month = 1; month <= 12; month++) {
      for (let day = Date.UTC(2025, 0, 1); day <= Date.UTC(2028, 11, 31); day += 86_400_000) {
        const iso = new Date(day).toISOString().slice(0, 10);
        const key = fiscalYearKey(iso, month);
        const { startsOn, endsOn } = fiscalYearBounds(key, month);
        expect(isFiscalYearKey(key, month), `${iso} from month ${month}`).toBe(true);
        expect(startsOn <= iso && iso <= endsOn, `${iso} in ${key} from month ${month}`).toBe(true);
        expect([fiscalYearKey(startsOn, month), fiscalYearKey(endsOn, month)]).toEqual([key, key]);
        const after = new Date(Date.parse(`${endsOn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        expect(fiscalYearBounds(fiscalYearKey(after, month), month).startsOn).toBe(after);
      }
    }
  });
});

describe('financial year start per organisation', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createWorld({ fiscalYear: null, autoRunJobs: false });
    await completeIdentity(w, w.ngoA);
    await completeIdentity(w, w.ngoB, 'Bodhi Society Trust');
  });
  afterAll(() => w.close());

  const settingsOf = (tenant: string) => w.platform.administration.settings(w.as(tenant));
  const startIn = (tenant: string, month: unknown) => w.platform.administration.saveSettings(w.as(tenant), { financialYearStartMonth: month });
  const open = (tenant: string, key: string) => w.platform.db.withTenant(tenant, (tx) => w.platform.ledger.openFiscalYear(asTx(tx), admin, key));
  const close = (tenant: string, key: string) => w.platform.db.withTenant(tenant, (tx) => w.platform.ledger.closePeriod(asTx(tx), admin, key));
  const post = (tenant: string, date: string) =>
    w.platform.db.withTenant(tenant, (tx) =>
      w.platform.ledger.post(asTx(tx), admin, {
        date,
        lines: [
          { accountCode: 'BANK', debit: 10 },
          { accountCode: 'DONATION_INCOME', credit: 10 },
        ],
      }),
    );
  const receipt = async (tenant: string, date: string) =>
    (await w.platform.db.withTenant(tenant, (tx) => w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date, amount: 1 }))).number;
  const periods = (tenant: string) =>
    w.platform.db.withTenant(tenant, (tx) =>
      typed(tx)
        .selectFrom('fiscal_period')
        .select(['key', sql<string>`starts_on::text`.as('startsOn'), sql<string>`ends_on::text`.as('endsOn'), 'status'])
        .orderBy('key')
        .execute(),
    );

  it('starts in April unless changed, and checks the month', async () => {
    expect(await settingsOf(w.ngoA)).toMatchObject({ financialYearStartMonth: 4, financialYearFixed: false });
    for (const bad of [0, 13, 1.5, '1', null]) {
      const err = await expectCode(startIn(w.ngoB, bad), 'validation_failed');
      expect((err as { issues?: { path: string }[] }).issues?.[0]?.path).toBe('financialYearStartMonth');
    }
    expect(await startIn(w.ngoB, 1)).toMatchObject({ financialYearStartMonth: 1, financialYearFixed: false });
    expect(await settingsOf(w.ngoA)).toMatchObject({ financialYearStartMonth: 4 });
    const audit = await w.platform.db.withTenant(w.ngoB, (tx) =>
      typed(tx).selectFrom('audit_event').select(['before', 'after']).where('action', '=', 'settings.changed').execute(),
    );
    const startMonth = audit.filter((e) => (e.after as Record<string, unknown> | null)?.['financialYearStartMonth'] !== undefined);
    expect(startMonth).toEqual([{ before: { financialYearStartMonth: 4 }, after: { financialYearStartMonth: 1 } }]);
  });

  it("numbers receipts per each organisation's own year and then refuses a change", async () => {
    expect(await receipt(w.ngoA, '2027-03-31')).toBe('RCPT/2026-27/00001');
    expect(await receipt(w.ngoA, '2027-04-01')).toBe('RCPT/2027-28/00001');
    expect(await receipt(w.ngoA, '2026-12-31')).toBe('RCPT/2026-27/00002');
    expect(await receipt(w.ngoB, '2026-12-31')).toBe('RCPT/2026/00001');
    expect(await receipt(w.ngoB, '2027-01-01')).toBe('RCPT/2027/00001');
    expect(await receipt(w.ngoB, '2027-03-31')).toBe('RCPT/2027/00002');

    expect(await settingsOf(w.ngoA)).toMatchObject({ financialYearStartMonth: 4, financialYearFixed: true });
    const err = await expectCode(startIn(w.ngoA, 7), 'rule_violation');
    expect(err.message).toMatch(/cannot change once a financial year has been opened or a receipt issued/);
    expect(await settingsOf(w.ngoA)).toMatchObject({ financialYearStartMonth: 4 });
    expect(await startIn(w.ngoA, 4)).toMatchObject({ financialYearStartMonth: 4 });
  });

  it("opens, posts into and closes each organisation's own years", async () => {
    await expectCode(open(w.ngoB, '2025-26'), 'validation_failed');
    await expectCode(open(w.ngoA, '2025'), 'validation_failed');
    await open(w.ngoA, '2025-26');
    await open(w.ngoB, '2025');
    await open(w.ngoB, '2026');
    expect(await periods(w.ngoA)).toEqual([{ key: '2025-26', startsOn: '2025-04-01', endsOn: '2026-03-31', status: 'open' }]);
    expect(await periods(w.ngoB)).toEqual([
      { key: '2025', startsOn: '2025-01-01', endsOn: '2025-12-31', status: 'open' },
      { key: '2026', startsOn: '2026-01-01', endsOn: '2026-12-31', status: 'open' },
    ]);
    await expectCode(startIn(w.ngoB, 4), 'rule_violation');

    await post(w.ngoA, '2026-02-15');
    await post(w.ngoB, '2026-02-15');
    await close(w.ngoB, '2025');
    await expectCode(close(w.ngoA, '2025'), 'not_found');
    await post(w.ngoA, '2025-12-31');
    const closed = await expectCode(post(w.ngoB, '2025-12-31'), 'rule_violation');
    expect(closed.message).toBe('Financial year 2025 is closed.');
    const missing = await expectCode(post(w.ngoA, '2026-04-01'), 'rule_violation');
    expect(missing.message).toBe('Financial year 2026-27 is not open.');

    const tb = (tenant: string, key: string) => w.platform.db.withTenant(tenant, (tx) => w.platform.ledger.trialBalance(asTx(tx), key));
    expect((await tb(w.ngoA, '2025-26')).find((r) => r.code === 'BANK')?.debit).toBe('20.00');
    expect((await tb(w.ngoB, '2026')).find((r) => r.code === 'BANK')?.debit).toBe('10.00');
  });

  it('numbers records and groups financial-year totals by each organisation\'s year', async () => {
    const fyA = fiscalYearKey(today(), 4);
    const fyB = fiscalYearKey(today(), 1);
    const builder = w.platform.builderSupport();
    expect(await builder.nextNumber(w.as(w.ngoA), 'donation', 'fiscal_year')).toEqual({ next: 1, fy: fyA, period: fyA });
    expect(await builder.nextNumber(w.as(w.ngoB), 'donation', 'fiscal_year')).toEqual({ next: 1, fy: fyB, period: fyB });

    const paid = async (tenant: string, paidOn: string) => {
      const ctx = w.as(tenant);
      const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Meera', amount: 100 });
      const done = await w.platform.records.transition(ctx, record.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn } });
      return { number: record.number, receipt: done.receipts[0]!.number };
    };
    expect(await paid(w.ngoA, '2025-12-31')).toEqual({ number: `DON/${fyA}/00001`, receipt: 'RCPT/2025-26/00001' });
    expect(await paid(w.ngoA, '2026-01-02')).toEqual({ number: `DON/${fyA}/00002`, receipt: 'RCPT/2025-26/00002' });
    expect(await paid(w.ngoB, '2026-01-02')).toEqual({ number: `DON/${fyB}/00001`, receipt: 'RCPT/2026/00002' });
    await expectCode(paid(w.ngoB, '2025-12-31'), 'rule_violation');

    const byYear = (tenant: string) =>
      w.platform.aggregates.aggregate(w.as(tenant), 'donation', { measure: 'count', groupBy: { period: 'financialYear', dateField: 'paidOn' } });
    expect(await byYear(w.ngoA)).toEqual({ buckets: [{ key: '2025-26', label: 'FY 2025-26', value: 2 }] });
    expect(await byYear(w.ngoB)).toEqual({ buckets: [{ key: '2026', label: 'FY 2026', value: 1 }] });
  });
});
