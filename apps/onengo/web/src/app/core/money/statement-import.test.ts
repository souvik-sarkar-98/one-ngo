import { describe, expect, it } from 'vitest';
import {
  chunks,
  guessDateOrder,
  guessRoles,
  initialSetup,
  parseAmount,
  parseCsv,
  parseDate,
  readLines,
  readSetup,
  setupProblem,
  setupStorageKey,
  usableLines,
  writeSetup,
  type ImportSetup,
} from './statement-import';

describe('reading a CSV file', () => {
  it('reads rows, quoted cells with commas and quotes, a BOM and Windows line endings', () => {
    const text = '\uFEFFDate,Narration,Amount\r\n03/11/2026,"UPI, Asha ""A"" Verma",5000.00\r\n\r\n05/11/2026,SMS CHARGES,-23.60\r\n';
    expect(parseCsv(text)).toEqual([
      ['Date', 'Narration', 'Amount'],
      ['03/11/2026', 'UPI, Asha "A" Verma', '5000.00'],
      ['05/11/2026', 'SMS CHARGES', '-23.60'],
    ]);
  });

  it('keeps a line break inside quotes and picks the delimiter the heading uses', () => {
    expect(parseCsv('a;b\n"x\ny";2')).toEqual([
      ['a', 'b'],
      ['x\ny', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('gives nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('dates', () => {
  it('reads each way of writing a date, and refuses days that do not exist', () => {
    expect(parseDate('03/11/2026', 'dmy')).toBe('2026-11-03');
    expect(parseDate('03-11-26', 'dmy')).toBe('2026-11-03');
    expect(parseDate('11/03/2026', 'mdy')).toBe('2026-11-03');
    expect(parseDate('2026-11-03', 'ymd')).toBe('2026-11-03');
    expect(parseDate('03 Nov 2026', 'dmy')).toBe('2026-11-03');
    expect(parseDate('3-Nov-26', 'mdy')).toBe('2026-11-03');
    expect(parseDate('03/11/2026 14:05:00', 'dmy')).toBe('2026-11-03');
    expect(parseDate('31/02/2026', 'dmy')).toBeNull();
    expect(parseDate('13/13/2026', 'dmy')).toBeNull();
    expect(parseDate('2026-11-03', 'dmy')).toBeNull();
    expect(parseDate('', 'dmy')).toBeNull();
    expect(parseDate('soon', 'dmy')).toBeNull();
  });

  it('judges the order from the file: a part above 12 settles it', () => {
    expect(guessDateOrder(['03/11/2026', '25/11/2026'])).toBe('dmy');
    expect(guessDateOrder(['11/03/2026', '11/25/2026'])).toBe('mdy');
    expect(guessDateOrder(['2026-11-03'])).toBe('ymd');
    expect(guessDateOrder(['03/11/2026'])).toBe('dmy');
    expect(guessDateOrder([])).toBe('dmy');
  });
});

describe('amounts', () => {
  it('reads plain, comma, Indian-grouped and signed amounts as exact decimals', () => {
    expect(parseAmount('5000')).toBe('5000.00');
    expect(parseAmount('5,000.5')).toBe('5000.50');
    expect(parseAmount('1,00,000.00')).toBe('100000.00');
    expect(parseAmount('-23.60')).toBe('-23.60');
    expect(parseAmount('+23.60')).toBe('23.60');
    expect(parseAmount('₹ 1,240.00')).toBe('1240.00');
    expect(parseAmount('Rs. 99')).toBe('99.00');
    expect(parseAmount('(500.00)')).toBe('-500.00');
    expect(parseAmount('500.00 Dr')).toBe('-500.00');
    expect(parseAmount('500.00 Cr')).toBe('500.00');
  });

  it('refuses what is not an amount, or has fractions of a paisa', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('1.234')).toBeNull();
    expect(parseAmount('1,2345')).toBeNull();
    expect(parseAmount('12-3')).toBeNull();
  });

  it('keeps large amounts exact', () => {
    expect(parseAmount('9007199254740.99')).toBe('9007199254740.99');
  });
});

describe('guessing the columns', () => {
  it('knows the common headings and leaves balance alone', () => {
    expect(guessRoles(['Txn Date', 'Value Dt', 'Narration', 'Chq/Ref No', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'])).toEqual({
      'Txn Date': 'date',
      'Value Dt': 'ignore',
      Narration: 'description',
      'Chq/Ref No': 'reference',
      'Withdrawal Amt.': 'moneyOut',
      'Deposit Amt.': 'moneyIn',
      'Closing Balance': 'ignore',
    });
    expect(guessRoles(['Date', 'Description', 'Amount'])).toEqual({ Date: 'date', Description: 'description', Amount: 'amount' });
  });

  it('chooses separate columns when both money columns are there, and the date order from the rows', () => {
    const headers = ['Date', 'Narration', 'Debit', 'Credit'];
    const setup = initialSetup(headers, [['25/11/2026', 'x', '1', '']]);
    expect(setup.amountStyle).toBe('split');
    expect(setup.dateOrder).toBe('dmy');
    expect(initialSetup(['Date', 'Description', 'Amount'], []).amountStyle).toBe('single');
  });

  it('uses the saved setup for headings it knows, and a guess for new ones', () => {
    const setup = initialSetup(['Date', 'Particulars', 'Amount', 'Extra'], [], { roles: { Particulars: 'description', Amount: 'amount' }, dateOrder: 'mdy', amountStyle: 'single' });
    expect(setup.roles).toMatchObject({ Date: 'date', Particulars: 'description', Amount: 'amount', Extra: 'ignore' });
    expect(setup.dateOrder).toBe('mdy');
  });

  it('says what is missing', () => {
    const base: ImportSetup = { roles: { A: 'date', B: 'description', C: 'amount' }, dateOrder: 'dmy', amountStyle: 'single' };
    const headers = ['A', 'B', 'C'];
    expect(setupProblem(base, headers)).toBeNull();
    expect(setupProblem({ ...base, roles: { ...base.roles, A: 'ignore' } }, headers)).toBe('date');
    expect(setupProblem({ ...base, roles: { ...base.roles, B: 'ignore' } }, headers)).toBe('description');
    expect(setupProblem({ ...base, roles: { ...base.roles, C: 'ignore' } }, headers)).toBe('amount');
    expect(setupProblem({ ...base, roles: { ...base.roles, C: 'date' } }, headers)).toBe('twice');
    expect(setupProblem({ ...base, amountStyle: 'split' }, headers)).toBe('amount');
  });
});

describe('turning rows into lines', () => {
  const headers = ['Date', 'Narration', 'Ref', 'Debit', 'Credit', 'Balance'];
  const setup: ImportSetup = { roles: { Date: 'date', Narration: 'description', Ref: 'reference', Debit: 'moneyOut', Credit: 'moneyIn', Balance: 'ignore' }, dateOrder: 'dmy', amountStyle: 'split' };

  it('makes money in positive and money out negative, with the bank reference', () => {
    const rows = readLines(headers, [['03/11/2026', 'Donor', '', '', '5,000.00', '9000'], ['12/11/2026', 'Salary', 'N311224', '18,000.00', '', '']], setup);
    expect(usableLines(rows)).toEqual([
      { date: '2026-11-03', amount: '5000.00', description: 'Donor' },
      { date: '2026-11-12', amount: '-18000.00', description: 'Salary', reference: 'N311224' },
    ]);
  });

  it('flags the rows that cannot be used, by their row in the file', () => {
    const rows = readLines(
      headers,
      [
        ['31/02/2026', 'Bad date', '', '', '1', ''],
        ['03/11/2026', 'No amount', '', '', '', ''],
        ['03/11/2026', 'Both', '', '5', '5', ''],
        ['03/11/2026', '', '', '', '5', ''],
        ['03/11/2026', 'Fraction', '', '', '1.234', ''],
        ['03/11/2026', 'Fine', '', '', '5', ''],
      ],
      setup,
    );
    expect(rows.map((r) => [r.row, r.problem])).toEqual([
      [2, 'date'],
      [3, 'amount'],
      [4, 'bothAmounts'],
      [5, 'description'],
      [6, 'amount'],
      [7, null],
    ]);
    expect(usableLines(rows)).toHaveLength(1);
  });

  it('reads one signed amount column', () => {
    const single: ImportSetup = { roles: { Date: 'date', Narration: 'description', Debit: 'amount' }, dateOrder: 'dmy', amountStyle: 'single' };
    const rows = readLines(headers, [['03/11/2026', 'Fee', '', '-23.60', '', '']], single);
    expect(usableLines(rows)).toEqual([{ date: '2026-11-03', amount: '-23.60', description: 'Fee' }]);
  });

  it('splits long files into pieces of at most 1,000, in order', () => {
    const items = Array.from({ length: 2500 }, (_, i) => i);
    const pieces = chunks(items);
    expect(pieces.map((p) => p.length)).toEqual([1000, 1000, 500]);
    expect(pieces.flat()).toEqual(items);
    expect(chunks([])).toEqual([]);
  });
});

describe('remembering the setup', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it('saves per account and reads it back', () => {
    const store = memory();
    const key = setupStorageKey('asha', 'upi');
    expect(key).not.toBe(setupStorageKey('asha', 'cash'));
    const setup: ImportSetup = { roles: { Date: 'date', Narration: 'description' }, dateOrder: 'mdy', amountStyle: 'split' };
    writeSetup(store, key, setup);
    expect(readSetup(store, key)).toEqual(setup);
  });

  it('ignores anything unreadable or unknown', () => {
    const store = memory();
    store.setItem('k', 'not json');
    expect(readSetup(store, 'k')).toBeNull();
    store.setItem('k', JSON.stringify({ roles: { A: 'date', B: 'bogus' }, dateOrder: 'xyz', amountStyle: 'weird' }));
    expect(readSetup(store, 'k')).toEqual({ roles: { A: 'date' } });
    expect(readSetup(store, 'missing')).toBeNull();
  });
});
