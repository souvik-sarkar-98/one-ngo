import { formatMoney, t } from '../i18n/i18n';
import type { RowView, Tone } from '../rows';

/** A money account as the server returns it. `balance` is the ledger balance as text, e.g. "1250.00". */
export interface MoneyAccount {
  id: string;
  key: string;
  name: string;
  kind: MoneyKind;
  ledgerCode: string;
  holderUserId: string | null;
  custodian: string | null;
  upiId: string | null;
  allowNegative: boolean;
  status: 'active' | 'closed';
  balance: string;
}

export const MONEY_KINDS = ['bank', 'cash', 'wallet', 'investment'] as const;
export type MoneyKind = (typeof MONEY_KINDS)[number];

/** The body `POST /api/money/accounts` takes. */
export interface OpenAccountBody {
  key: string;
  name: string;
  kind: MoneyKind;
  custodian?: string;
  upiId?: string;
  ledgerCode?: string;
  allowNegative?: boolean;
}

/** The body PATCH /api/money/accounts/:key takes. An empty upiId or custodian clears it. */
export interface UpdateAccountBody {
  name: string;
  upiId: string;
  custodian: string;
  allowNegative: boolean;
}

/** Keys are the account's short name in the API and in transfers; they cannot change later. */
const KEY = /^[a-z][a-z0-9-]{0,40}$/;
/** The same check the server applies to a UPI ID. */
const UPI = /^[\w.-]{2,256}@[a-zA-Z]{2,64}$/;

export function kindLabel(kind: string): string {
  return (MONEY_KINDS as readonly string[]).includes(kind) ? t(`ui.money.kind.${kind}`) : kind;
}

export function statusLabel(status: string): string {
  return status === 'closed' ? t('ui.money.status.closed') : t('ui.money.status.active');
}

/** The open form's starting values. A bank allows a negative balance by default, as the server does. */
export function openAccountDefaults(): Record<string, string | boolean> {
  return { key: '', name: '', kind: 'bank', custodian: '', upiId: '', ledgerCode: '', allowNegative: false };
}

/** The edit form's starting values: what the account holds now. */
export function editAccountValues(a: MoneyAccount): Record<string, string | boolean> {
  return { key: a.key, name: a.name, kind: kindLabel(a.kind), ledgerCode: a.ledgerCode, upiId: a.upiId ?? '', custodian: a.custodian ?? '', allowNegative: a.allowNegative };
}

/** Checks the edit form's values. Only the name, UPI ID, holder and overdraft rule can change. */
export function validateEditAccount(values: Record<string, unknown>): { ok: true; body: UpdateAccountBody } | { ok: false; issues: Record<string, string> } {
  const issues: Record<string, string> = {};
  const text = (k: string) => String(values[k] ?? '').trim();
  const name = text('name');
  const upiId = text('upiId');
  if (!name) issues['name'] = t('ui.records.required', { field: t('ui.money.accountName') });
  if (upiId && !UPI.test(upiId)) issues['upiId'] = t('ui.money.badUpi');
  if (Object.keys(issues).length) return { ok: false, issues };
  return { ok: true, body: { name, upiId, custodian: text('custodian'), allowNegative: values['allowNegative'] === true } };
}

/** Checks the open form's values before anything is sent; the server checks them again. */
export function validateOpenAccount(values: Record<string, unknown>): { ok: true; body: OpenAccountBody } | { ok: false; issues: Record<string, string> } {
  const issues: Record<string, string> = {};
  const text = (k: string) => String(values[k] ?? '').trim();
  const key = text('key');
  const name = text('name');
  const kind = text('kind');
  const upiId = text('upiId');
  const custodian = text('custodian');
  const ledgerCode = text('ledgerCode');
  if (!key) issues['key'] = t('ui.records.required', { field: t('ui.money.key') });
  else if (!KEY.test(key)) issues['key'] = t('ui.money.badKey');
  if (!name) issues['name'] = t('ui.records.required', { field: t('ui.money.accountName') });
  if (!(MONEY_KINDS as readonly string[]).includes(kind)) issues['kind'] = t('ui.records.required', { field: t('ui.money.kindField') });
  if (upiId && !UPI.test(upiId)) issues['upiId'] = t('ui.money.badUpi');
  if (Object.keys(issues).length) return { ok: false, issues };
  return {
    ok: true,
    body: {
      key,
      name,
      kind: kind as MoneyKind,
      ...(custodian ? { custodian } : {}),
      ...(upiId ? { upiId } : {}),
      ...(ledgerCode ? { ledgerCode } : {}),
      allowNegative: values['allowNegative'] === true,
    },
  };
}

export const moneyColumns = (): { key: string; label: string }[] => [
  { key: 'name', label: t('ui.money.col.name') },
  { key: 'kind', label: t('ui.money.col.kind') },
  { key: 'ledger', label: t('ui.money.col.ledger') },
  { key: 'upi', label: t('ui.money.col.upi') },
  { key: 'balance', label: t('ui.money.col.balance') },
  { key: 'overdraft', label: t('ui.money.col.overdraft') },
  { key: 'status', label: t('ui.money.col.status') },
];

const STATUS_TONE: Record<MoneyAccount['status'], Tone> = { active: 'success', closed: 'neutral' };

/** What the person may do with the accounts, from their capabilities. Looking at an account's statement needs only the right to read. */
export interface MoneyCaps {
  manage?: boolean;
  reconcile?: boolean;
  transfer?: boolean;
}

/**
 * A row's buttons. A closed account keeps its Statement only. A cash account has no bank statement to
 * compare with, so it has no Reconcile.
 */
export function moneyActions(a: Pick<MoneyAccount, 'kind' | 'status'>, caps: MoneyCaps): RowView['actions'] {
  const active = a.status === 'active';
  return [
    { id: 'statement', label: t('ui.money.statement') },
    ...(active && caps.reconcile && a.kind !== 'cash' ? [{ id: 'reconcile', label: t('ui.money.reconcile') }] : []),
    ...(active && caps.transfer ? [{ id: 'transfer', label: t('ui.money.transfer') }] : []),
    ...(active && caps.manage ? [{ id: 'edit', label: t('ui.money.edit') }] : []),
  ];
}

/** One account on RowView. The balance is shown as money; closed accounts are muted. */
export function moneyRow(a: MoneyAccount, caps: MoneyCaps = {}): RowView {
  const kind = kindLabel(a.kind);
  const upi = a.upiId ?? '—';
  const balance = formatMoney(Number(a.balance));
  const status = statusLabel(a.status);
  const overdraft = a.allowNegative ? t('ui.money.overdraft.allowed') : t('ui.money.overdraft.off');
  return {
    id: a.id,
    title: a.name,
    subtitle: `${kind} · ${a.ledgerCode}`,
    lines: a.upiId ? [`${t('ui.money.col.upi')}: ${a.upiId}`] : [],
    meta: balance,
    badge: { label: status, tone: STATUS_TONE[a.status] },
    ...(a.status === 'closed' && { muted: true }),
    cells: [
      { key: 'name', label: t('ui.money.col.name'), value: a.name },
      { key: 'kind', label: t('ui.money.col.kind'), value: kind },
      { key: 'ledger', label: t('ui.money.col.ledger'), value: a.ledgerCode },
      { key: 'upi', label: t('ui.money.col.upi'), value: upi },
      { key: 'balance', label: t('ui.money.col.balance'), value: balance },
      { key: 'overdraft', label: t('ui.money.col.overdraft'), value: overdraft },
      { key: 'status', label: t('ui.money.col.status'), value: status },
    ],
    actions: moneyActions(a, caps),
  };
}

// ---------------------------------------------------------------- balances on a date

/** What `GET /api/money/balances` returns: each active account as it stood on a day, and their total. */
export interface BalancesView {
  asOf: string;
  total: string;
  accounts: { key: string; name: string; kind: MoneyKind; ledgerCode: string; balance: string }[];
}

/** Whole paise of a decimal text such as "1250.50" or "-3"; NaN when it is not an amount. */
export function paise(text: string | number): number {
  const s = String(text).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  const negative = s.startsWith('-');
  const [whole = '0', frac = ''] = s.replace('-', '').split('.');
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -value : value;
}

/** Paise back to money text with two decimals, such as "-396.00". */
export function decimalOf(p: number): string {
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** The organisation's day as the browser knows it, as `2026-11-26`. */
export function todayLocal(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A day typed in the date box: a real calendar day like 2026-11-26. */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------- transfers

/** The body `POST /api/money/transfers` takes. */
export interface TransferBody {
  from: string;
  to: string;
  amount: string;
  date: string;
  reference?: string;
  overrideReason?: string;
}

/** The transfer form's starting values: the date today, and the first two accounts when there are two. */
export function transferDefaults(accounts: Pick<MoneyAccount, 'key'>[], from?: string): Record<string, string> {
  const start = from && accounts.some((a) => a.key === from) ? from : (accounts[0]?.key ?? '');
  const other = accounts.find((a) => a.key !== start)?.key ?? '';
  return { from: start, to: other, amount: '', date: todayLocal(), reference: '', overrideReason: '' };
}

type Sender = Pick<MoneyAccount, 'key' | 'name' | 'balance' | 'allowNegative'>;

/** Whether the amount would take the sending account below zero when it does not allow that. The server decides; this only warns. */
export function wouldOverdraw(values: Record<string, unknown>, accounts: Sender[]): boolean {
  const from = accounts.find((a) => a.key === String(values['from'] ?? ''));
  const amount = paise(String(values['amount'] ?? ''));
  return !!from && !from.allowNegative && Number.isFinite(amount) && amount > 0 && amount > paise(from.balance);
}

/** What the two accounts would hold after the transfer, from the balances on the page; null until the form can be worked out. */
export function transferAfter(values: Record<string, unknown>, accounts: Sender[]): { from: string; to: string; fromBalance: string; toBalance: string } | null {
  const from = accounts.find((a) => a.key === String(values['from'] ?? ''));
  const to = accounts.find((a) => a.key === String(values['to'] ?? ''));
  const amount = paise(String(values['amount'] ?? ''));
  if (!from || !to || from.key === to.key || !Number.isFinite(amount) || amount <= 0) return null;
  return { from: from.name, to: to.name, fromBalance: decimalOf(paise(from.balance) - amount), toBalance: decimalOf(paise(to.balance) + amount) };
}

/**
 * Checks the transfer form before anything is sent; the server checks again. `askReason` is set after the server has
 * refused for want of money, or when the amount is already known to overdraw: the reason is then required.
 */
export function validateTransfer(
  values: Record<string, unknown>,
  accounts: Sender[],
  askReason: boolean,
): { ok: true; body: TransferBody } | { ok: false; issues: Record<string, string> } {
  const issues: Record<string, string> = {};
  const text = (k: string) => String(values[k] ?? '').trim();
  const from = text('from');
  const to = text('to');
  const amount = text('amount');
  const date = text('date');
  const reference = text('reference');
  const reason = text('overrideReason');
  if (!from) issues['from'] = t('ui.records.required', { field: t('ui.money.transferFrom') });
  if (!to) issues['to'] = t('ui.records.required', { field: t('ui.money.transferTo') });
  else if (to === from) issues['to'] = t('ui.money.sameAccount');
  if (!amount) issues['amount'] = t('ui.records.required', { field: t('ui.money.transferAmount') });
  else if (!(paise(amount) > 0)) issues['amount'] = t('ui.money.badAmount');
  if (!date) issues['date'] = t('ui.records.required', { field: t('ui.money.transferDate') });
  else if (!isDay(date)) issues['date'] = t('ui.money.badDate');
  if ((askReason || wouldOverdraw(values, accounts)) && !reason) issues['overrideReason'] = t('ui.money.reasonNeeded');
  if (Object.keys(issues).length) return { ok: false, issues };
  const needsReason = askReason || wouldOverdraw(values, accounts);
  return { ok: true, body: { from, to, amount: decimalOf(paise(amount)), date, ...(reference ? { reference } : {}), ...(needsReason && reason ? { overrideReason: reason } : {}) } };
}
