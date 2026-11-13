import { gunzipSync } from 'node:zlib';
import { expect, type APIRequestContext, type APIResponse, type Locator, type Page } from '@playwright/test';
import { label } from '../catalogue.js';
import { dayLabel } from '../records.js';

/** Functional plan section 34.1, the ids in these journeys that are also release smoke. */
const SMOKE = new Set(['FT-REC-109', 'FT-DON-020', 'FT-DON-026', 'FT-DON-035', 'FT-DON-037', 'FT-DON-040', 'FT-FIN-028']);

export function tags(journey: string, id: string, priority: 'P0' | 'P1' | 'P2'): string[] {
  return ['@e2e', `@${journey}`, `@${priority}`, ...(SMOKE.has(id) ? ['@smoke'] : [])];
}

export const messages = {
  pan: 'Enter the PAN as five letters, four digits and a letter, for example ABCDE1234F.',
  duplicatePan: 'Another donor already has this PAN.',
  fee: 'The processing fee cannot be more than the donation.',
  future: 'The payment date cannot be in the future.',
  upi: 'Enter the UPI transaction reference.',
  reminder: 'Send a payment reminder to the donor by email?',
} as const;

/** A PAN no seeded donor has: five letters, four digits, a letter. */
export function uniquePan(): string {
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const digits = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `E2E${letter()}${letter()}${digits}${letter()}`;
}

/** Today as the server's `today()` sees it: a UTC date. A paid-on date after it is refused (DEF-15). */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** An ISO date as a local Date at midnight, the way the datepicker labels its days. */
export function localDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The financial year label of an ISO date for an April start, as `fiscalYearKey` gives it: `2026-27`. */
export function fiscalYear(iso: string, startMonth = 4): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const start = m >= startMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Sequence number at the end of `PREFIX/<fy>/00012`. */
export function sequenceOf(number: string): number {
  return Number(number.split('/').at(-1));
}

/** Opens a Material datepicker from its field and picks `iso`, moving month by month. */
export async function pickDate(page: Page, field: Locator, iso: string): Promise<void> {
  const target = localDate(iso);
  await field.click();
  const day = page.getByRole('button', { name: dayLabel(target), exact: true });
  for (let i = 0; i < 36 && (await day.count()) === 0; i++) {
    const shown = page.locator('.mat-calendar-period-button');
    const text = (await shown.textContent()) ?? '';
    const current = new Date(`1 ${text.trim()}`);
    const back = Number.isNaN(current.getTime()) ? target < new Date() : target < current;
    await page.getByRole('button', { name: back ? /Previous month/i : /Next month/i }).click();
  }
  await day.click();
}

/** The Mark as paid sheet, opened from an open donation panel. */
export async function openMarkAsPaid(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Mark as paid', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Mark as paid' });
  await expect(sheet).toBeVisible();
  return sheet;
}

export async function choosePaymentMethod(page: Page, sheet: Locator, method: string): Promise<void> {
  await sheet.getByRole('combobox', { name: 'Payment method' }).click();
  await page.getByRole('option', { name: method, exact: true }).click();
}

export async function submitMarkAsPaid(sheet: Locator): Promise<void> {
  await sheet.getByRole('button', { name: 'Mark as paid', exact: true }).click();
}

export function createDialog(page: Page, type: 'donor' | 'donation'): Locator {
  return page.getByRole('dialog', { name: label('ui.records.createTitle', { type }) });
}

export interface RecordView {
  id: string;
  number: string | null;
  status: string | null;
  version: number;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface Receipt {
  id: string;
  number: string;
  seriesKey: string;
  period: string;
  amount: string;
  date: string;
  status: 'issued' | 'void';
  recordId: string | null;
}

export interface SaveResult {
  record: RecordView;
  receipts: Receipt[];
  journalEntryIds: string[];
}

export async function getRecord(api: APIRequestContext, type: string, id: string): Promise<RecordView> {
  const res = await api.get(`/api/records/${type}/${id}`);
  expect(res.status(), `GET /api/records/${type}/${id}`).toBe(200);
  return (await res.json()) as RecordView;
}

export async function createRecordApi(api: APIRequestContext, type: string, data: Record<string, unknown>): Promise<RecordView> {
  const res = await api.post(`/api/records/${type}`, { data });
  expect(res.status(), `create ${type} ${JSON.stringify(data)}: ${await res.text()}`).toBe(201);
  return ((await res.json()) as SaveResult).record;
}

export function tryCreate(api: APIRequestContext, type: string, data: Record<string, unknown>): Promise<APIResponse> {
  return api.post(`/api/records/${type}`, { data });
}

export async function tryTransition(api: APIRequestContext, type: string, id: string, transition: string, data?: Record<string, unknown>): Promise<APIResponse> {
  const { version } = await getRecord(api, type, id);
  return api.post(`/api/records/${type}/${id}/transitions/${transition}`, { data: { ...(data ? { data } : {}), expectedVersion: version } });
}

export async function transition(api: APIRequestContext, type: string, id: string, key: string, data?: Record<string, unknown>): Promise<SaveResult> {
  const res = await tryTransition(api, type, id, key, data);
  expect(res.status(), `${key} on ${type} ${id}: ${await res.text()}`).toBe(200);
  return (await res.json()) as SaveResult;
}

export async function tryUpdate(api: APIRequestContext, type: string, id: string, data: Record<string, unknown>): Promise<APIResponse> {
  const { version } = await getRecord(api, type, id);
  return api.patch(`/api/records/${type}/${id}`, { data: { data, expectedVersion: version } });
}

export async function receiptsOf(api: APIRequestContext, type: string, id: string): Promise<Receipt[]> {
  const res = await api.get(`/api/records/${type}/${id}/receipts`);
  expect(res.status(), `receipts of ${type} ${id}`).toBe(200);
  return (await res.json()) as Receipt[];
}

export async function findRecords(api: APIRequestContext, type: string, search: string, match: (r: RecordView) => boolean): Promise<RecordView[]> {
  const res = await api.post(`/api/records/${type}/query`, { data: { search, limit: 50 } });
  expect(res.status(), `query ${type} "${search}"`).toBe(200);
  return ((await res.json()) as { items: RecordView[] }).items.filter(match);
}

export function refused(res: APIResponse): boolean {
  return res.status() >= 400 && res.status() < 500;
}

export type Snapshot = Record<string, Record<string, unknown>[]>;

/**
 * The organisation's rows as the administrator export gives them (`GET /api/admin/export`,
 * gzipped JSON lines). Members cannot read journals, notifications or the audit log any other way.
 */
export async function tenantSnapshot(admin: APIRequestContext, tables: string[]): Promise<Snapshot> {
  const res = await admin.get('/api/admin/export');
  expect(res.status(), 'GET /api/admin/export').toBe(200);
  const raw = await res.body();
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const out: Snapshot = Object.fromEntries(tables.map((t) => [t, []]));
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const { table, row } = JSON.parse(line) as { table: string; row: Record<string, unknown> };
    out[table]?.push(row);
  }
  return out;
}

export const postingTables = ['journal_entry', 'journal_line', 'ledger_account', 'fiscal_period'];

export interface Posting {
  id: string;
  date: string;
  period: string;
  status: string;
  rule: string | null;
  lines: { code: string; debit: number; credit: number }[];
}

/** A date or timestamp column as a local calendar day; the export writes `date` columns as timestamps. */
function day(value: unknown): string {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const d = new Date(text);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Journal entries posted for one record, not reversals, with their lines by account code. */
export function postingsFor(s: Snapshot, recordId: string): Posting[] {
  const codes = new Map(s.ledger_account!.map((a) => [a.id, String(a.code)]));
  const periods = new Map(s.fiscal_period!.map((p) => [p.id, String(p.key)]));
  return s
    .journal_entry!.filter((e) => e.source_record_id === recordId && !e.reverses_entry_id)
    .map((e) => ({
      id: String(e.id),
      date: day(e.entry_date),
      period: periods.get(e.period_id) ?? '',
      status: String(e.status),
      rule: (e.source_rule as string | null) ?? null,
      lines: s
        .journal_line!.filter((l) => l.entry_id === e.id)
        .map((l) => ({ code: codes.get(l.account_id) ?? '', debit: Number(l.debit), credit: Number(l.credit) })),
    }));
}

/** One balanced posting: debit `debitCode`, credit DONATION_INCOME, both `amount`. */
export function expectDonationPosting(postings: Posting[], debitCode: 'BANK' | 'CASH', amount: number): Posting {
  const live = postings.filter((p) => p.status === 'posted');
  expect(live, 'one posted journal entry for the donation').toHaveLength(1);
  const entry = live[0]!;
  const debit = entry.lines.reduce((sum, l) => sum + l.debit, 0);
  const credit = entry.lines.reduce((sum, l) => sum + l.credit, 0);
  expect(debit, 'debits equal credits').toBeCloseTo(credit, 2);
  expect(entry.lines).toEqual(
    expect.arrayContaining([
      { code: debitCode, debit: amount, credit: 0 },
      { code: 'DONATION_INCOME', debit: 0, credit: amount },
    ]),
  );
  expect(entry.lines).toHaveLength(2);
  return entry;
}

/** Waits for the record's email to leave `pending`: `sent`, or `skipped` with a reason. */
export async function settledEmail(admin: APIRequestContext, recordId: string, subject: string): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await expect
    .poll(
      async () => {
        const s = await tenantSnapshot(admin, ['notification']);
        found = s.notification!.find((n) => n.record_id === recordId && n.channel === 'email' && n.subject === subject);
        return found ? String(found.status) : 'none';
      },
      { message: `email "${subject}" for record ${recordId}`, timeout: 30_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toMatch(/^(sent|skipped)$/);
  return found!;
}
