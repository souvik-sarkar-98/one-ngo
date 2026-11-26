import { formatMoney, t } from '../i18n/i18n';
import { csvOf, type CsvCell } from './csv';
import { isDay } from './money';

/** What `GET /api/ledger/trial-balance` returns: each ledger account's balance on a day, and the two totals. */
export interface TrialBalanceLine {
  code: string;
  name: string;
  type: string;
  active: boolean;
  /** Set when the ledger account belongs to a money account, so its name can open that account's statement. */
  moneyKey: string | null;
  debit: string;
  credit: string;
}

export interface TrialBalanceView {
  asOf: string;
  year: { key: string; startsOn: string; endsOn: string };
  rows: TrialBalanceLine[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

export const trialBalanceUrl = (asOf: string, includeZero: boolean): string => {
  const q = new URLSearchParams({ asOf });
  if (includeZero) q.set('includeZero', 'true');
  return `/api/ledger/trial-balance?${q}`;
};

/** The kinds of ledger account in the order a person reads them, each with a plain explanation. */
export const GROUPS = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type GroupKey = (typeof GROUPS)[number];

const isGroup = (type: string): type is GroupKey => (GROUPS as readonly string[]).includes(type);

const money = (v: string): string => (Number(v) === 0 ? '' : formatMoney(Number(v)));

export interface TrialRow {
  code: string;
  name: string;
  moneyKey: string | null;
  inactive: boolean;
  debit: string;
  credit: string;
}

export interface TrialGroup {
  key: string;
  title: string;
  hint: string;
  rows: TrialRow[];
}

/** The rows grouped by kind of account, in reading order. A kind we do not know goes last, under its own name. */
export function groupRows(rows: TrialBalanceLine[]): TrialGroup[] {
  const order = [...GROUPS, ...[...new Set(rows.map((r) => r.type))].filter((x) => !isGroup(x))];
  return order
    .map((key) => ({
      key,
      title: isGroup(key) ? t(`ui.money.tb.group.${key}`) : key,
      hint: isGroup(key) ? t(`ui.money.tb.groupHint.${key}`) : '',
      rows: rows
        .filter((r) => r.type === key)
        .map(
          (r): TrialRow => ({
            code: r.code,
            name: r.code === 'SURPLUS_BF' ? t('ui.money.tb.surplusBf') : r.name,
            moneyKey: r.moneyKey,
            inactive: !r.active,
            debit: money(r.debit),
            credit: money(r.credit),
          }),
        ),
    }))
    .filter((g) => g.rows.length);
}

/** How far apart the two totals are, as a decimal; `0.00` when the books are in order. */
export function difference(view: Pick<TrialBalanceView, 'totalDebit' | 'totalCredit'>): string {
  const cents = Math.round(Number(view.totalDebit) * 100) - Math.round(Number(view.totalCredit) * 100);
  return (Math.abs(cents) / 100).toFixed(2);
}

export const totalsText = (view: Pick<TrialBalanceView, 'totalDebit' | 'totalCredit'>) => ({ debit: formatMoney(Number(view.totalDebit)), credit: formatMoney(Number(view.totalCredit)) });

/** The last day of the month before `today`, as `2026-10-31`. */
export function endOfLastMonth(today: string): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** Why the day typed cannot be used, or null when it can. */
export const dayIssue = (asOf: string): string | null => (isDay(asOf) ? null : t('ui.money.badDate'));

/** The trial balance as a CSV: raw decimals in the Debit and Credit columns, so a spreadsheet can add them. */
export function trialBalanceCsv(view: TrialBalanceView): string {
  const rows: CsvCell[][] = [
    [t('ui.money.tb.title'), `${t('ui.money.asOf')} ${view.asOf}`, view.year.key],
    [t('ui.money.tb.code'), t('ui.money.tb.account'), t('ui.money.tb.type'), t('ui.money.tb.debit'), t('ui.money.tb.credit')],
    ...view.rows.map((r) => [r.code, r.name, isGroup(r.type) ? t(`ui.money.tb.group.${r.type}`) : r.type, r.debit, r.credit]),
    ['', t('ui.money.tb.total'), '', view.totalDebit, view.totalCredit],
  ];
  return csvOf(rows);
}

export const trialBalanceFileName = (view: Pick<TrialBalanceView, 'asOf'>): string => `trial-balance-${view.asOf}.csv`;
