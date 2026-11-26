import { formatDate, formatMoney, t } from '../i18n/i18n';
import { isDay, paise, type MoneyKind } from './money';

/** What the reconcile screen reads from and sends to the server, and the plain words around it. */

export type LineStatus = 'unmatched' | 'matched' | 'ignored';

/** A line of the bank's statement, as `GET /api/money/accounts/:key/statement` returns it. Money in is positive. */
export interface BankLine {
  id: string;
  date: string;
  amount: string;
  description: string;
  reference: string | null;
  status: LineStatus;
  journalLineId: string | null;
  note: string | null;
}

/** An entry in the books on the account's ledger account, not yet taken by a statement line. */
export interface BookLine {
  id: string;
  entryId: string;
  date: string;
  memo: string | null;
  amount: string;
}

export interface SignOff {
  id: string;
  asOf: string;
  statementBalance: string;
  bookBalance: string;
  outstandingBook: string;
  note: string | null;
  signedOffBy: string;
  signedOffAt: string;
}

export interface Report {
  asOf: string;
  statementBalance: string;
  bookBalance: string;
  outstandingBook: { lines: BookLine[]; total: string };
  unbooked: { lines: BankLine[]; total: string };
  difference: string;
  reconciled: boolean;
  lastSignOff: SignOff | null;
}

export interface ImportOutcome {
  added: number;
  duplicates: number;
  matched: number;
}

export interface LedgerAccount {
  code: string;
  name: string;
  type: string;
  active: boolean;
  /** Set when the account is a money account's ledger account. */
  moneyKey: string | null;
}

export interface ReconAccountInfo {
  key: string;
  name: string;
  kind: MoneyKind;
}

// ---------------------------------------------------------------- addresses

const base = (key: string) => `/api/money/accounts/${encodeURIComponent(key)}`;

export const reconUrls = {
  lines: (key: string, status?: LineStatus) => `${base(key)}/statement${status ? `?status=${status}` : ''}`,
  bookLines: (key: string) => `${base(key)}/book-lines`,
  importLines: (key: string) => `${base(key)}/statement`,
  autoMatch: (key: string) => `${base(key)}/statement/auto-match`,
  act: (key: string, lineId: string, action: 'match' | 'ignore' | 'book' | 'reopen') => `${base(key)}/statement/${encodeURIComponent(lineId)}/${action}`,
  report: (key: string, asOf: string, statementBalance: string) => `${base(key)}/reconciliation?${new URLSearchParams({ asOf, statementBalance })}`,
  signOffs: (key: string) => `${base(key)}/reconciliations`,
};

// ---------------------------------------------------------------- reviewing lines

const sameAmount = (a: string, b: string): boolean => paise(a) === paise(b);

const gap = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));

/** The books' entries a statement line could be paired with: exactly the same amount, nearest date first. */
export function candidatesFor(line: Pick<BankLine, 'amount' | 'date'>, books: BookLine[]): BookLine[] {
  return books.filter((b) => sameAmount(b.amount, line.amount)).sort((x, y) => gap(x.date, line.date) - gap(y.date, line.date) || x.date.localeCompare(y.date));
}

/** The button to point at: Match when the books have an entry of the same amount, Book when they have none. */
export const likelyAction = (line: Pick<BankLine, 'amount' | 'date'>, books: BookLine[]): 'match' | 'book' => (candidatesFor(line, books).length ? 'match' : 'book');

/** A signed amount for reading: `+5,000.00` for money in, `-23.60` for money out. */
export function signedMoney(amount: string): string {
  const n = Number(amount);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatMoney(Math.abs(n))}`;
}

export function bankRow(line: BankLine, books: BookLine[]) {
  const n = Number(line.amount);
  return {
    id: line.id,
    date: formatDate(line.date),
    description: line.description,
    reference: line.reference ?? '',
    amount: signedMoney(line.amount),
    moneyIn: n > 0,
    status: line.status,
    note: line.note,
    likely: line.status === 'unmatched' ? likelyAction(line, books) : null,
  };
}

/** The label of a book entry in the Match list. */
export const bookLabel = (b: BookLine): string => `${formatDate(b.date)} · ${b.memo?.trim() || t('ui.money.reconcile.noMemo')}`;

/** Ledger accounts for the other side of a booked line: every active ledger account that is not a money account. The kinds a person most likely wants come first. */
export function otherSideChoices(accounts: LedgerAccount[], line: Pick<BankLine, 'amount'>): { code: string; label: string; group: string }[] {
  const out = Number(line.amount) < 0;
  const first = out ? ['expense'] : ['income'];
  const rank = (a: LedgerAccount) => (first.includes(a.type) ? 0 : 1);
  return accounts
    .filter((a) => a.active && !a.moneyKey)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((a) => ({ code: a.code, label: `${a.name} (${a.code})`, group: rank(a) === 0 ? t(out ? 'ui.money.reconcile.groupSpending' : 'ui.money.reconcile.groupIncome') : t('ui.money.reconcile.groupOther') }));
}

// ---------------------------------------------------------------- the comparison and sign-off

/** The rows of the "how the books compare" table, in the order a person reads them. */
export function comparisonRows(report: Report) {
  return [
    { key: 'statement', label: t('ui.money.reconcile.statementBalance'), value: formatMoney(Number(report.statementBalance)), detail: '' },
    { key: 'books', label: t('ui.money.reconcile.booksBalance'), value: formatMoney(Number(report.bookBalance)), detail: '' },
    {
      key: 'outstanding',
      label: t('ui.money.reconcile.outstanding'),
      value: formatMoney(Number(report.outstandingBook.total)),
      detail: report.outstandingBook.lines.slice(0, 3).map((l) => `${formatDate(l.date)} ${l.memo ?? ''}`.trim()).join('; '),
    },
    {
      key: 'unbooked',
      label: t('ui.money.reconcile.unbooked'),
      value: formatMoney(Number(report.unbooked.total)),
      detail: report.unbooked.lines.slice(0, 3).map((l) => `${l.description} (${signedMoney(l.amount)})`).join('; '),
    },
    { key: 'difference', label: t('ui.money.reconcile.difference'), value: formatMoney(Number(report.difference)), detail: '' },
  ];
}

/** The reason the person cannot sign off yet, as plain words; null when they can. */
export function signOffBlocker(report: Report | null): string | null {
  if (!report) return t('ui.money.reconcile.needFigures');
  if (report.lastSignOff && report.lastSignOff.asOf >= report.asOf) return t('ui.money.reconcile.alreadySigned', { date: formatDate(report.lastSignOff.asOf) });
  if (report.unbooked.lines.length) return t('ui.money.reconcile.stillUnmatched', { count: report.unbooked.lines.length });
  if (paise(report.difference) !== 0) return t('ui.money.reconcile.differs', { amount: formatMoney(Number(report.difference)) });
  return null;
}

/** Why the date and balance typed cannot be used, or null when they can. */
export function figuresIssue(asOf: string, balance: string): string | null {
  if (!isDay(asOf)) return t('ui.money.badDate');
  if (!balance.trim() || Number.isNaN(paise(balance.trim().replace(/,/g, '')))) return t('ui.money.reconcile.badBalance');
  return null;
}

/** The balance as typed (with commas) as the plain decimal the server takes. */
export const balanceText = (balance: string): string => balance.trim().replace(/,/g, '');

/** The sentence under the title: the last sign-off, or that there is none. */
export const lastSignedText = (last: SignOff | null | undefined): string => (last ? t('ui.money.reconcile.signedTo', { date: formatDate(last.asOf) }) : t('ui.money.reconcile.neverSigned'));

export function signOffRow(s: SignOff) {
  return {
    id: s.id,
    asOf: formatDate(s.asOf),
    statement: formatMoney(Number(s.statementBalance)),
    books: formatMoney(Number(s.bookBalance)),
    outstanding: formatMoney(Number(s.outstandingBook)),
    note: s.note ?? '',
    signedOn: formatDate(s.signedOffAt.slice(0, 10)),
  };
}

/** The line shown after an import. */
export function importSummary(o: ImportOutcome, needDecision: number): string {
  return t('ui.money.reconcile.imported', { added: o.added, duplicates: o.duplicates, matched: o.matched, need: needDecision });
}

/** Adds up the answers of several import requests. */
export const addOutcomes = (all: ImportOutcome[]): ImportOutcome =>
  all.reduce((sum, o) => ({ added: sum.added + o.added, duplicates: sum.duplicates + o.duplicates, matched: sum.matched + o.matched }), { added: 0, duplicates: 0, matched: 0 });
