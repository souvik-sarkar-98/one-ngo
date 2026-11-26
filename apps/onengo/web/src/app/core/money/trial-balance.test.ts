import { describe, expect, it } from 'vitest';
import { formatMoney } from '../i18n/i18n';
import { difference, endOfLastMonth, groupRows, trialBalanceCsv, trialBalanceFileName, trialBalanceUrl, type TrialBalanceLine, type TrialBalanceView } from './trial-balance';

const line = (c: Partial<TrialBalanceLine>): TrialBalanceLine => ({ code: 'BANK', name: 'Main bank', type: 'asset', active: true, moneyKey: 'upi', debit: '0.00', credit: '0.00', ...c });

const view = (rows: TrialBalanceLine[], totals = { totalDebit: '1000.00', totalCredit: '1000.00' }): TrialBalanceView => ({
  asOf: '2026-11-26',
  year: { key: '2026-27', startsOn: '2026-04-01', endsOn: '2027-03-31' },
  rows,
  ...totals,
  balanced: totals.totalDebit === totals.totalCredit,
});

describe('trial balance', () => {
  it('asks for the day, and for empty accounts only when wanted', () => {
    expect(trialBalanceUrl('2026-11-26', false)).toBe('/api/ledger/trial-balance?asOf=2026-11-26');
    expect(trialBalanceUrl('2026-11-26', true)).toBe('/api/ledger/trial-balance?asOf=2026-11-26&includeZero=true');
  });

  it('groups rows by kind in reading order and leaves out kinds with no rows', () => {
    const groups = groupRows([
      line({ code: 'INC', name: 'Donations', type: 'income', moneyKey: null, credit: '1000.00' }),
      line({ code: 'BANK', debit: '1000.00' }),
      line({ code: 'ODD', name: 'Odd', type: 'memo', moneyKey: null, debit: '5.00' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['asset', 'income', 'memo']);
    expect(groups[0]!.title).toBe('Assets');
    expect(groups[0]!.rows[0]).toMatchObject({ code: 'BANK', moneyKey: 'upi', debit: formatMoney(1000), credit: '' });
    expect(groups[1]!.rows[0]).toMatchObject({ debit: '', credit: formatMoney(1000) });
    expect(groups[2]!.title).toBe('memo');
  });

  it('names the line that rolls earlier years into the funds in plain words', () => {
    const g = groupRows([line({ code: 'SURPLUS_BF', name: 'Surplus from earlier years', type: 'equity', moneyKey: null, credit: '500.00' })]);
    expect(g[0]!.rows[0]!.name).toBe('Surplus from earlier years');
  });

  it('measures the gap between the totals exactly', () => {
    expect(difference({ totalDebit: '1000.10', totalCredit: '1000.10' })).toBe('0.00');
    expect(difference({ totalDebit: '1000.30', totalCredit: '1000.10' })).toBe('0.20');
    expect(difference({ totalDebit: '10.00', totalCredit: '250.00' })).toBe('240.00');
  });

  it('finds the end of last month, across a year boundary too', () => {
    expect(endOfLastMonth('2026-11-26')).toBe('2026-10-31');
    expect(endOfLastMonth('2027-01-05')).toBe('2026-12-31');
    expect(endOfLastMonth('2028-03-31')).toBe('2028-02-29');
  });

  it('exports plain decimals with a total line', () => {
    const v = view([line({ debit: '1000.00' }), line({ code: 'INC', name: 'Donations, general', type: 'income', moneyKey: null, credit: '1000.00' })]);
    const rows = trialBalanceCsv(v).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(rows[1]).toBe('Code,Account,Kind,Debit,Credit');
    expect(rows[2]).toBe('BANK,Main bank,Assets,1000.00,0.00');
    expect(rows[3]).toBe('INC,"Donations, general",Income,0.00,1000.00');
    expect(rows.at(-1)).toBe(',Total,,1000.00,1000.00');
    expect(trialBalanceFileName(v)).toBe('trial-balance-2026-11-26.csv');
  });
});
