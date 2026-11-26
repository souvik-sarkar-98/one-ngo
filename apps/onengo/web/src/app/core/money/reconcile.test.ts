import { describe, expect, it } from 'vitest';
import { formatMoney } from '../i18n/i18n';
import {
  addOutcomes,
  balanceText,
  bankRow,
  candidatesFor,
  comparisonRows,
  figuresIssue,
  likelyAction,
  otherSideChoices,
  reconUrls,
  signOffBlocker,
  signOffRow,
  signedMoney,
  type BankLine,
  type BookLine,
  type LedgerAccount,
  type Report,
} from './reconcile';

const line = (c: Partial<BankLine> = {}): BankLine => ({ id: 's1', date: '2026-11-03', amount: '5000.00', description: 'UPI/CR/Donor', reference: null, status: 'unmatched', journalLineId: null, note: null, ...c });
const book = (c: Partial<BookLine> = {}): BookLine => ({ id: 'b1', entryId: 'e1', date: '2026-11-06', memo: 'Donation DON/1', amount: '5000.00', ...c });

const report = (c: Partial<Report> = {}): Report => ({
  asOf: '2026-11-25',
  statementBalance: '212400.00',
  bookBalance: '210400.00',
  outstandingBook: { lines: [book({ amount: '-2000.00', memo: 'Cheque 004512' })], total: '-2000.00' },
  unbooked: { lines: [], total: '0.00' },
  difference: '0.00',
  reconciled: true,
  lastSignOff: null,
  ...c,
});

describe('addresses', () => {
  it('encodes the account key and the report figures', () => {
    expect(reconUrls.lines('a b')).toBe('/api/money/accounts/a%20b/statement');
    expect(reconUrls.lines('upi', 'unmatched')).toBe('/api/money/accounts/upi/statement?status=unmatched');
    expect(reconUrls.act('upi', 'l1', 'book')).toBe('/api/money/accounts/upi/statement/l1/book');
    expect(reconUrls.report('upi', '2026-11-25', '2124.00')).toBe('/api/money/accounts/upi/reconciliation?asOf=2026-11-25&statementBalance=2124.00');
  });
});

describe('pairing lines', () => {
  it('offers only entries of exactly the same amount, nearest day first', () => {
    const books = [book({ id: 'far', date: '2026-11-09' }), book({ id: 'near', date: '2026-11-04' }), book({ id: 'other', amount: '4999.99' }), book({ id: 'decimal', amount: '5000' })];
    expect(candidatesFor(line(), books).map((b) => b.id)).toEqual(['near', 'decimal', 'far']);
  });

  it('points at Match when an entry of the same amount exists, and at Book when none does', () => {
    expect(likelyAction(line(), [book()])).toBe('match');
    expect(likelyAction(line(), [book({ amount: '1.00' })])).toBe('book');
    expect(likelyAction(line(), [])).toBe('book');
  });

  it('writes money in with a plus and money out with a minus', () => {
    expect(signedMoney('5000.00')).toBe(`+${formatMoney(5000)}`);
    expect(signedMoney('-23.60')).toBe(`−${formatMoney(23.6)}`);
    const row = bankRow(line({ amount: '-23.60' }), []);
    expect(row).toMatchObject({ moneyIn: false, likely: 'book' });
    expect(bankRow(line({ status: 'matched' }), []).likely).toBeNull();
  });

  it('offers non-money ledger accounts for booking, the likely kind first', () => {
    const accounts: LedgerAccount[] = [
      { code: 'BANK', name: 'Bank', type: 'asset', active: true, moneyKey: 'upi' },
      { code: 'INC', name: 'Interest income', type: 'income', active: true, moneyKey: null },
      { code: 'EXP', name: 'Bank charges', type: 'expense', active: true, moneyKey: null },
      { code: 'OLD', name: 'Old', type: 'expense', active: false, moneyKey: null },
    ];
    expect(otherSideChoices(accounts, line({ amount: '-23.60' })).map((a) => a.code)).toEqual(['EXP', 'INC']);
    expect(otherSideChoices(accounts, line()).map((a) => a.code)).toEqual(['INC', 'EXP']);
    expect(otherSideChoices(accounts, line())[0]!.label).toBe('Interest income (INC)');
  });
});

describe('the comparison and sign-off', () => {
  it('lists the figures in reading order and names what is outstanding', () => {
    const rows = comparisonRows(report());
    expect(rows.map((r) => r.key)).toEqual(['statement', 'books', 'outstanding', 'unbooked', 'difference']);
    expect(rows[2]!.detail).toContain('Cheque 004512');
    expect(rows[4]!.value).toBe(formatMoney(0));
  });

  it('allows sign-off only when nothing is unmatched and the difference is zero', () => {
    expect(signOffBlocker(report())).toBeNull();
    expect(signOffBlocker(null)).not.toBeNull();
    expect(signOffBlocker(report({ difference: '0.01' }))).toMatch(/differ/);
    expect(signOffBlocker(report({ unbooked: { lines: [line()], total: '5000.00' } }))).toMatch(/unmatched/);
    // A zero difference alone is not enough: unmatched lines are already counted in the sum.
    expect(signOffBlocker(report({ difference: '0.00', unbooked: { lines: [line(), line({ id: 's2' })], total: '0.00' } }))).toMatch(/2 statement lines/);
  });

  it('refuses a day on or before the last sign-off', () => {
    const last = { id: 'x', asOf: '2026-11-25', statementBalance: '1', bookBalance: '1', outstandingBook: '0', note: null, signedOffBy: 'u', signedOffAt: '2026-11-26T10:00:00Z' };
    expect(signOffBlocker(report({ lastSignOff: last }))).toMatch(/already signed off/);
    expect(signOffBlocker(report({ lastSignOff: { ...last, asOf: '2026-10-31' } }))).toBeNull();
  });

  it('checks the day and balance typed, and takes a balance with commas', () => {
    expect(figuresIssue('2026-11-25', '2,12,400.00')).toBeNull();
    expect(figuresIssue('2026-02-30', '1')).not.toBeNull();
    expect(figuresIssue('2026-11-25', '')).not.toBeNull();
    expect(figuresIssue('2026-11-25', 'abc')).not.toBeNull();
    expect(balanceText(' 2,12,400.00 ')).toBe('212400.00');
  });

  it('shows a past sign-off with its dates and figures', () => {
    const row = signOffRow({ id: 'x', asOf: '2026-10-31', statementBalance: '198200.00', bookBalance: '198200.00', outstandingBook: '0.00', note: null, signedOffBy: 'u', signedOffAt: '2026-11-01T09:30:00Z' });
    expect(row).toMatchObject({ statement: formatMoney(198200), note: '' });
  });

  it('adds up the answers of several import requests', () => {
    expect(addOutcomes([{ added: 1000, duplicates: 0, matched: 400 }, { added: 5, duplicates: 2, matched: 1 }])).toEqual({ added: 1005, duplicates: 2, matched: 401 });
    expect(addOutcomes([])).toEqual({ added: 0, duplicates: 0, matched: 0 });
  });
});
