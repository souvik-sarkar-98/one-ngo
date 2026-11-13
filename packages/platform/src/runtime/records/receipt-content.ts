import { ruleViolation } from '@onengo/kernel/errors';
import type { IssuerSnapshot } from '../../domain/organisations/organisation.js';
import type { ReceiptContent } from '../../domain/receipts/receipt-content.js';
import type { FieldDef, ReceiptLayout, ReceiptLayoutRow } from '../definitions/types.js';
import { ExpressionError } from '../expressions/expression.js';
import { renderTemplate } from '../definitions/template.js';
import { evalValue } from './save/scope.js';

/** What a receipt rule knew when it issued the receipt. */
export interface ReceiptWording {
  ruleKey: string;
  layout?: ReceiptLayout;
  /** Record data, plus `id`, `number` and `status`. */
  record: Record<string, unknown>;
  recordType: { label: string; titleField?: string | null; fields: FieldDef[] };
  receipt: { number: string; amount: string; date: string };
  seriesLabel: string;
  issuer: IssuerSnapshot;
}

const UNPRINTABLE = new Set(['longText', 'richText', 'reference', 'file', 'signature']);
const SEALED = /^enc:v1:/;

const moneyFormat = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('en-IN-u-nu-latn', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Rupees, the way the English print view writes an amount. */
export function formatReceiptMoney(amount: number | string): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return `${n < 0 ? '-' : ''}₹${moneyFormat.format(Math.abs(n))}`;
}

function formatReceiptDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return dateFormat.format(new Date(`${value}T00:00:00Z`));
}

function fill(text: string, scope: Record<string, unknown>, where: string): string {
  try {
    return renderTemplate(text, scope);
  } catch (e) {
    if (e instanceof ExpressionError) throw ruleViolation(`Configuration error in ${where}: ${e.message}`);
    throw e;
  }
}

function printable(field: FieldDef): boolean {
  return !field.sensitive && !field.readPermission && !UNPRINTABLE.has(field.type);
}

function fieldText(field: FieldDef, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && (SEALED.test(value) || !value.trim())) return null;
  if (field.type === 'money' && (typeof value === 'number' || typeof value === 'string')) return formatReceiptMoney(value);
  if (field.type === 'date' && typeof value === 'string') return formatReceiptDate(value);
  if (field.type === 'boolean') return value === true ? 'Yes' : value === false ? 'No' : null;
  if (field.type === 'choice' && (typeof value === 'string' || typeof value === 'number')) {
    const key = String(value);
    return field.choices?.find((c) => c.value === key)?.label ?? key;
  }
  if (field.type === 'multiChoice' && Array.isArray(value)) {
    const labels = value.map((v) => field.choices?.find((c) => c.value === String(v))?.label ?? String(v));
    return labels.length ? labels.join(', ') : null;
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return null;
}

function scopeOf(input: ReceiptWording, registration?: IssuerSnapshot['registrations'][number]): Record<string, unknown> {
  return {
    record: input.record,
    receipt: {
      number: input.receipt.number,
      amount: formatReceiptMoney(input.receipt.amount),
      date: formatReceiptDate(input.receipt.date),
    },
    issuer: { displayName: input.issuer.displayName, legalName: input.issuer.legalName },
    series: { label: input.seriesLabel },
    ...(registration ? { registration } : {}),
  };
}

function defaultRows(input: ReceiptWording): { label: string; value: string }[] {
  const fields = input.recordType.fields;
  const titleKey = input.recordType.titleField;
  const title = titleKey ? fields.find((f) => f.key === titleKey) : undefined;
  const donor = title && printable(title) ? fieldText(title, input.record[title.key]) : null;
  const shown = new Set([titleKey, 'amount']);
  const rows = [
    ...(donor && title ? [{ label: title.label, value: donor }] : []),
    { label: 'Amount', value: formatReceiptMoney(input.receipt.amount) },
    { label: `For ${input.recordType.label}`, value: String(input.record['number'] ?? '—') },
  ];
  for (const field of fields) {
    if (shown.has(field.key) || !printable(field)) continue;
    const value = fieldText(field, input.record[field.key]);
    if (value) rows.push({ label: field.label, value });
  }
  return rows;
}

function rowValue(row: ReceiptLayoutRow, input: ReceiptWording, scope: Record<string, unknown>, index: number): string {
  if (row.field) {
    const field = input.recordType.fields.find((f) => f.key === row.field);
    if (!field) return '';
    return fieldText(field, input.record[field.key]) ?? '';
  }
  if (!row.value) return '';
  const value = evalValue(row.value, scope, `receipt layout row ${index + 1}`);
  if (value === null || value === undefined || value === '') return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * Fills a receipt rule's layout. With no layout, the wording is the print
 * view's own: series title, acknowledgement, amount and the record's other
 * filled-in fields. A clause is kept only when the issuer holds that registration.
 */
export function resolveReceiptContent(input: ReceiptWording): ReceiptContent {
  const layout = input.layout;
  const scope = scopeOf(input);
  const title = layout?.title?.trim() ? fill(layout.title, scope, 'receipt layout title') : input.seriesLabel;
  const donorField = input.recordType.titleField ? input.recordType.fields.find((f) => f.key === input.recordType.titleField) : undefined;
  const donor = donorField && printable(donorField) ? fieldText(donorField, input.record[donorField.key]) : null;
  const statement = layout?.statement !== undefined
    ? fill(layout.statement, scope, 'receipt layout statement').trim() || null
    : donor
      ? `Received with thanks from ${donor} the sum of ${formatReceiptMoney(input.receipt.amount)} towards ${input.recordType.label}.`
      : null;
  const thanks = layout?.thanks !== undefined ? fill(layout.thanks, scope, 'receipt layout thanks') : 'Thank you for your generous support.';
  const rows = layout?.rows
    ? layout.rows
        .map((row, index) => ({ label: fill(row.label, scope, `receipt layout row ${index + 1}`), value: rowValue(row, input, scope, index) }))
        .filter((row) => row.label.trim() && row.value.trim())
    : defaultRows(input);
  const clauses = (layout?.clauses ?? []).flatMap((clause) => {
    const registration = input.issuer.registrations.find((r) => r.type === clause.registration);
    if (!registration) return [];
    const text = fill(clause.text, scopeOf(input, registration), `receipt layout clause ${clause.registration}`).trim();
    return text ? [text] : [];
  });
  return { ruleKey: input.ruleKey, title: title.trim() || input.seriesLabel, statement, rows, clauses, thanks };
}
