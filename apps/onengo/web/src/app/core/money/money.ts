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
  return { key: '', name: '', kind: 'bank', custodian: '', upiId: '', ledgerCode: '', allowNegative: true };
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
  { key: 'status', label: t('ui.money.col.status') },
];

const STATUS_TONE: Record<MoneyAccount['status'], Tone> = { active: 'success', closed: 'neutral' };

/** One account on RowView. The balance is shown as money; closed accounts are muted. */
export function moneyRow(a: MoneyAccount): RowView {
  const kind = kindLabel(a.kind);
  const upi = a.upiId ?? '—';
  const balance = formatMoney(Number(a.balance));
  const status = statusLabel(a.status);
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
      { key: 'status', label: t('ui.money.col.status'), value: status },
    ],
    actions: a.status === 'active' ? [{ id: 'edit', label: t('ui.money.edit') }] : [],
  };
}
