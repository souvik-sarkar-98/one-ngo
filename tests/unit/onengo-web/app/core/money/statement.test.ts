import { describe, expect, it } from 'vitest';
import { formatMoney } from '../../../../../../apps/onengo/web/src/app/core/i18n/i18n';
import { lineDetails, rangeIssue, sourceLink, statementCsv, statementFileName, statementRow, statementTotals, statementUrl, type StatementLine, type StatementView } from '../../../../../../apps/onengo/web/src/app/core/money/statement';

const line = (c: Partial<StatementLine> = {}): StatementLine => ({
  id: 'l1',
  entryId: 'e1',
  date: '2026-04-12',
  memo: 'Donation DON/26-27/00001 from Asha Verma',
  debit: '1000.00',
  credit: '0.00',
  balance: '1000.00',
  kind: 'record',
  reversed: false,
  sourceRecordId: 'r1',
  sourceRecordType: 'donation',
  sourceRecordNumber: 'DON/26-27/00001',
  ...c,
});

const view = (lines: StatementLine[]): StatementView => ({
  account: { key: 'upi', name: 'Main bank, SBI', kind: 'bank', ledgerCode: 'BANK', status: 'active' },
  from: '2026-04-01',
  to: '2027-03-31',
  offset: 0,
  limit: 2000,
  opening: '0.00',
  totalIn: '1000.00',
  totalOut: '300.00',
  closing: '700.00',
  count: lines.length,
  lines,
});

describe('the statement request', () => {
  it('leaves the days to the server until they are given, and pages by offset', () => {
    expect(statementUrl('upi', {})).toBe('/api/money/accounts/upi/ledger');
    expect(statementUrl('upi', { from: '2026-04-01', to: '2026-04-30' }, 2000)).toBe('/api/money/accounts/upi/ledger?from=2026-04-01&to=2026-04-30&offset=2000');
    expect(statementUrl('a b', {})).toBe('/api/money/accounts/a%20b/ledger');
  });

  it('refuses days that are not days, or that run backwards', () => {
    expect(rangeIssue('2026-04-01', '2026-04-30')).toBeNull();
    expect(rangeIssue('2026-04-01', '2026-04-01')).toBeNull();
    expect(rangeIssue('', '2026-04-30')).not.toBeNull();
    expect(rangeIssue('2026-02-30', '2026-04-30')).not.toBeNull();
    expect(rangeIssue('2026-05-01', '2026-04-30')).toMatch(/after/);
  });
});

describe('a statement line', () => {
  it('shows money in or out and leaves the other blank, with the running balance', () => {
    expect(statementRow(line())).toMatchObject({ moneyIn: formatMoney(1000), moneyOut: '', balance: formatMoney(1000), negative: false });
    expect(statementRow(line({ debit: '0.00', credit: '300.00', balance: '-50.00' }))).toMatchObject({ moneyIn: '', moneyOut: formatMoney(300), negative: true });
  });

  it('links to the record it came from, and to nothing for a manual entry', () => {
    expect(sourceLink(line())).toEqual({ type: 'donation', id: 'r1' });
    expect(sourceLink(line({ sourceRecordId: null, sourceRecordType: null, kind: 'manual' }))).toBeNull();
    expect(statementRow(line()).reference).toBe('DON/26-27/00001');
  });

  it('says what it is when it has no memo', () => {
    expect(lineDetails(line({ memo: '  ' }))).toBe('DON/26-27/00001');
    expect(lineDetails(line({ memo: null, sourceRecordNumber: null, kind: 'transfer' }))).toBe('Transfer');
  });

  it('marks an entry that has been reversed', () => {
    expect(statementRow(line({ reversed: true })).reversed).toBe(true);
  });
});

describe('the figures above the statement', () => {
  it('shows opening, money in, money out and closing', () => {
    expect(statementTotals(view([])).map((x) => [x.key, x.value])).toEqual([
      ['opening', formatMoney(0)],
      ['in', formatMoney(1000)],
      ['out', formatMoney(300)],
      ['closing', formatMoney(700)],
    ]);
  });
});

describe('the statement as a CSV', () => {
  const lines = [line(), line({ id: 'l2', date: '2026-04-20', memo: 'Transfer Main bank to Cash', debit: '0.00', credit: '300.00', balance: '700.00', kind: 'transfer', sourceRecordId: null, sourceRecordType: null, sourceRecordNumber: null })];

  it('keeps raw decimals so a spreadsheet can add them, and quotes names with commas', () => {
    const csv = statementCsv(view(lines), lines).split('\r\n');
    expect(csv[0]).toBe('\uFEFF"Main bank, SBI",BANK,2026-04-01 to 2027-03-31');
    expect(csv[2]).toBe(',Opening balance,,,,,0.00');
    expect(csv[3]).toBe('2026-04-12,Donation DON/26-27/00001 from Asha Verma,From a record,DON/26-27/00001,1000.00,0.00,1000.00');
    expect(csv[4]).toBe('2026-04-20,Transfer Main bank to Cash,Transfer,,0.00,300.00,700.00');
    expect(csv[5]).toBe(',Closing balance,,,1000.00,300.00,700.00');
  });

  it('names the file by account and days', () => {
    expect(statementFileName(view([]))).toBe('statement-upi-2026-04-01-to-2027-03-31.csv');
  });
});
