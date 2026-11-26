import { formatDate, formatMoney, t } from '../i18n/i18n';
import { csvOf, type CsvCell } from './csv';
import { isDay, kindLabel, type MoneyKind } from './money';

/** Where an entry on the account came from, as `GET /api/money/accounts/:key/ledger` names it. */
export type LedgerLineKind = 'record' | 'transfer' | 'reversal' | 'manual';

export interface StatementLine {
  id: string;
  entryId: string;
  date: string;
  memo: string | null;
  debit: string;
  credit: string;
  /** What the account held after this line, running on from the opening balance. */
  balance: string;
  kind: LedgerLineKind;
  /** The entry has been undone by a reversal. */
  reversed: boolean;
  sourceRecordId: string | null;
  sourceRecordType: string | null;
  sourceRecordNumber: string | null;
}

/** One page of an account's ledger between two days, with the totals of the whole range. */
export interface StatementView {
  account: { key: string; name: string; kind: MoneyKind; ledgerCode: string; status: 'active' | 'closed' };
  from: string;
  to: string;
  offset: number;
  limit: number;
  opening: string;
  totalIn: string;
  totalOut: string;
  closing: string;
  count: number;
  lines: StatementLine[];
}

/** The request address for a page of the statement. Empty days leave the range to the server (the current financial year). */
export function statementUrl(key: string, range: { from?: string; to?: string }, offset = 0): string {
  const q = new URLSearchParams();
  if (range.from) q.set('from', range.from);
  if (range.to) q.set('to', range.to);
  if (offset > 0) q.set('offset', String(offset));
  const query = q.toString();
  return `/api/money/accounts/${encodeURIComponent(key)}/ledger${query ? `?${query}` : ''}`;
}

/** Why the two days cannot be used, or null when they can. */
export function rangeIssue(from: string, to: string): string | null {
  if (!isDay(from) || !isDay(to)) return t('ui.money.badDate');
  return from > to ? t('ui.money.rangeOrder') : null;
}

/** The record the line came from, opened in its list; null for a line with no record. */
export function sourceLink(line: Pick<StatementLine, 'sourceRecordId' | 'sourceRecordType'>): { type: string; id: string } | null {
  return line.sourceRecordId && line.sourceRecordType ? { type: line.sourceRecordType, id: line.sourceRecordId } : null;
}

const KIND_KEY: Record<LedgerLineKind, string> = {
  record: 'ui.money.lineKind.record',
  transfer: 'ui.money.lineKind.transfer',
  reversal: 'ui.money.lineKind.reversal',
  manual: 'ui.money.lineKind.manual',
};

export const lineKindLabel = (kind: LedgerLineKind): string => t(KIND_KEY[kind]);

/** What a statement line says in the Details column: its memo, or the record's number, or what kind of entry it is. */
export function lineDetails(line: StatementLine): string {
  return line.memo?.trim() || line.sourceRecordNumber || lineKindLabel(line.kind);
}

const amountText = (v: string): string => (Number(v) === 0 ? '' : formatMoney(Number(v)));

/** A line as the table draws it: money in and out are blank where there is none, and the balance may be negative. */
export function statementRow(line: StatementLine) {
  return {
    id: line.id,
    date: formatDate(line.date),
    details: lineDetails(line),
    kind: lineKindLabel(line.kind),
    link: sourceLink(line),
    reference: line.sourceRecordNumber,
    reversed: line.reversed,
    moneyIn: amountText(line.debit),
    moneyOut: amountText(line.credit),
    balance: formatMoney(Number(line.balance)),
    negative: Number(line.balance) < 0,
  };
}

/** The four figures above the table. */
export function statementTotals(view: Pick<StatementView, 'opening' | 'totalIn' | 'totalOut' | 'closing'>) {
  return [
    { key: 'opening', label: t('ui.money.opening'), value: formatMoney(Number(view.opening)) },
    { key: 'in', label: t('ui.money.moneyIn'), value: formatMoney(Number(view.totalIn)) },
    { key: 'out', label: t('ui.money.moneyOut'), value: formatMoney(Number(view.totalOut)) },
    { key: 'closing', label: t('ui.money.closing'), value: formatMoney(Number(view.closing)) },
  ];
}

/** The statement as a CSV: raw decimals, not formatted money, so a spreadsheet can add them up. */
export function statementCsv(view: StatementView, lines: StatementLine[]): string {
  const rows: CsvCell[][] = [
    [view.account.name, view.account.ledgerCode, `${view.from} to ${view.to}`],
    [t('ui.money.csv.date'), t('ui.money.csv.details'), t('ui.money.csv.type'), t('ui.money.csv.reference'), t('ui.money.moneyIn'), t('ui.money.moneyOut'), t('ui.money.col.balance')],
    ['', t('ui.money.opening'), '', '', '', '', view.opening],
    ...lines.map((l) => [l.date, lineDetails(l) + (l.reversed ? ` (${t('ui.money.reversed')})` : ''), lineKindLabel(l.kind), l.sourceRecordNumber ?? '', l.debit, l.credit, l.balance]),
    ['', t('ui.money.closing'), '', '', view.totalIn, view.totalOut, view.closing],
  ];
  return csvOf(rows);
}

export const statementFileName = (view: Pick<StatementView, 'account' | 'from' | 'to'>): string => `statement-${view.account.key}-${view.from}-to-${view.to}.csv`;

/** The kind and ledger account under the account's name. */
export const accountSubtitle = (view: Pick<StatementView, 'account'>): string => `${kindLabel(view.account.kind)} · ${view.account.ledgerCode}`;
