import { writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, request as playwrightRequest, type APIRequestContext, type APIResponse, type TestInfo } from '@playwright/test';
import { password } from '../accounts.js';
import { anonymousApi } from '../api.js';

/** PRIV in the functional test data: `privacy:consent:record`, `privacy:consent:read`, `privacy:erase`. */
export const privacyOfficer = { email: 'privacy@riverbank.example', name: 'Privacy Officer' } as const;

/** The integration fixture that keeps the dev SMTP messages; `npm run dev` starts it and sets INTEGRATION_FIXTURE_ORIGIN. */
export const fixtureOrigin = process.env.E2E_FIXTURE_URL ?? process.env.INTEGRATION_FIXTURE_ORIGIN ?? 'https://127.0.0.1:8095';

export const noMailbox = `The fixture mailbox at ${fixtureOrigin}/api/log is not reachable, so the invitation link that sets a throwaway member's password cannot be read. Start the app with npm run dev (integration fixture on) or set E2E_FIXTURE_URL.`;

// ------------------------------------------------------------------ responses

export async function body<T>(response: APIResponse, status: number | number[], what: string): Promise<T> {
  const wanted = Array.isArray(status) ? status : [status];
  if (!wanted.includes(response.status())) {
    throw new Error(`${what}: expected ${wanted.join(' or ')}, got ${response.status()} ${await response.text()}`);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

export interface ApiError {
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}

// ------------------------------------------------------------------- records

export interface RecordView {
  id: string;
  type: string;
  number: string | null;
  status: string | null;
  version: number;
  data: Record<string, unknown>;
}

export async function queryRecords(api: APIRequestContext, type: string, query: Record<string, unknown>): Promise<{ items: RecordView[]; total: number }> {
  return body(await api.post(`/api/records/${type}/query`, { data: query }), 200, `query ${type}`);
}

/** Every record matching the query, a page of 100 at a time. */
export async function allRecords(api: APIRequestContext, type: string, query: Record<string, unknown>): Promise<RecordView[]> {
  const out: RecordView[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await queryRecords(api, type, { ...query, limit: 100, offset });
    out.push(...page.items);
    if (page.items.length < 100 || out.length >= page.total) return out;
  }
}

export async function getRecord(api: APIRequestContext, type: string, id: string): Promise<RecordView> {
  return body(await api.get(`/api/records/${type}/${id}`), 200, `get ${type} ${id}`);
}

export async function createRecord(api: APIRequestContext, type: string, data: Record<string, unknown>, idempotencyKey?: string): Promise<RecordView> {
  const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : undefined;
  const saved = await body<{ record: RecordView }>(await api.post(`/api/records/${type}`, { data, headers }), 201, `create ${type}`);
  return saved.record;
}

/** The local calendar day before today as yyyy-mm-dd: never "in the future", whatever the server's date (DEF-15). */
export function yesterday(): string {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Mark as paid in cash yesterday; cash needs no reference (DEF-07 is about UPI). */
export async function markPaid(api: APIRequestContext, donation: RecordView): Promise<RecordView> {
  const saved = await body<{ record: RecordView }>(
    await api.post(`/api/records/donation/${donation.id}/transitions/markPaid`, {
      data: { data: { method: 'cash', paidOn: yesterday() }, expectedVersion: donation.version },
    }),
    200,
    `mark ${donation.number} paid`,
  );
  return saved.record;
}

// --------------------------------------------------------------------- import

export interface ImportView {
  id: string;
  status: 'uploaded' | 'mapped' | 'checked' | 'running' | 'done' | 'failed';
  rowCount: number;
  suggested: Record<string, string | null>;
  jobId: string | null;
  counts: { created: number; updated: number; failed: number } | null;
}

export interface CheckResult {
  rows: number;
  valid: number;
  invalid: number;
  creates: number;
  updates: number;
  problems: { row: number; column?: string; field?: string; message: string }[];
}

/** A CSV line: cells with a comma, quote or line break are quoted. */
export function csv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Writes a generated CSV into this test's output folder and returns its path. */
export function writeCsv(testInfo: TestInfo, name: string, text: string): string {
  const path = testInfo.outputPath(name);
  writeFileSync(path, text, 'utf8');
  return path;
}

export async function uploadImport(api: APIRequestContext, type: string, fileName: string, text: string): Promise<ImportView> {
  return body(
    await api.post(`/api/records/${type}/imports`, {
      headers: { 'content-type': 'text/csv', 'x-file-name': encodeURIComponent(fileName) },
      data: Buffer.from(text, 'utf8'),
    }),
    201,
    `upload ${fileName}`,
  );
}

export async function waitForImport(api: APIRequestContext, id: string, timeout: number): Promise<ImportView> {
  let view: ImportView | undefined;
  await expect
    .poll(
      async () => {
        view = await body<ImportView>(await api.get(`/api/imports/${id}`), 200, `import ${id}`);
        return view.status;
      },
      { timeout, intervals: [1000, 1500, 3000] },
    )
    .toMatch(/^(done|failed)$/);
  return view!;
}

// ---------------------------------------------------------------------- runs

/** Five capital letters that change each second and repeat only after about 137 days. */
export function runLetters(): string {
  let n = Math.floor(Date.now() / 1000) % 26 ** 5;
  let out = '';
  for (let i = 0; i < 5; i++) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

/** A PAN in the donor pattern (five letters, four digits, a letter), unique per run and row. */
export function panFor(letters: string, row: number, last = 'Z'): string {
  return `${letters}${String(row % 10000).padStart(4, '0')}${last}`;
}

/** An Indian mobile number written the way people type it, different for each row. */
export function phoneFor(row: number, seed: number): string {
  return `+91 9${String(row % 10000).padStart(4, '0')} ${String(seed % 100000).padStart(5, '0')}`;
}

// ------------------------------------------------------------------- mailbox

interface MailSummary {
  id: number;
  at: string;
  to: string[];
  subject: string;
}

/** The fixture's SMTP log, or null when the fixture is not running. */
export async function openMailbox(): Promise<APIRequestContext | null> {
  const mail = await playwrightRequest.newContext({ baseURL: fixtureOrigin, ignoreHTTPSErrors: true });
  try {
    const log = await mail.get('/api/log', { timeout: 5000 });
    if (log.ok()) return mail;
  } catch {
    // Not running.
  }
  await mail.dispose();
  return null;
}

export async function messagesTo(mail: APIRequestContext, email: string): Promise<MailSummary[]> {
  const log = await body<{ messages: MailSummary[] }>(await mail.get('/api/log'), 200, 'fixture mail log');
  const to = email.toLowerCase();
  return log.messages.filter((m) => m.to.some((a) => a.toLowerCase() === to));
}

/** Waits for a message to `email` newer than the `seen` count, and returns its raw text. */
export async function nextMessage(mail: APIRequestContext, email: string, seen: number, timeout = 30_000): Promise<string> {
  let found: MailSummary | undefined;
  await expect
    .poll(
      async () => {
        const list = await messagesTo(mail, email);
        found = list.length > seen ? list.sort((a, b) => b.id - a.id)[0] : undefined;
        return !!found;
      },
      { timeout, message: `a message to ${email}` },
    )
    .toBe(true);
  const raw = await mail.get(`/mail/${found!.id}`);
  expect(raw.status()).toBe(200);
  return raw.text();
}

/** The token of a `/reset-password?token=…` link in a raw message, whether it is plain, quoted-printable or base64. */
export function passwordLinkToken(raw: string): string | null {
  const find = (text: string) => {
    const m = /reset-password\?([^\s"'<>]+)/.exec(text.replace(/&amp;/g, '&'));
    return m ? new URLSearchParams(m[1]).get('token') : null;
  };
  const qp = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  const plain = find(qp);
  if (plain) return plain;
  for (const block of raw.match(/(?:^[A-Za-z0-9+/=]{16,}\r?\n)+/gm) ?? []) {
    const token = find(Buffer.from(block.replace(/\s+/g, ''), 'base64').toString('utf8'));
    if (token) return token;
  }
  return null;
}

/**
 * Adds a member with an invitation, reads the link from the fixture mailbox, and sets the shared
 * test password, so `memberApi(email)` and `signIn()` work for them. Returns the member's user id.
 */
export async function addMemberWithPassword(
  admin: APIRequestContext,
  mail: APIRequestContext,
  person: { email: string; name: string; roles: string[] },
): Promise<string> {
  const seen = (await messagesTo(mail, person.email)).length;
  const added = await body<{ userId: string }>(
    await admin.post('/api/admin/people', { data: { email: person.email, displayName: person.name, roles: person.roles, invite: true } }),
    201,
    `add ${person.email}`,
  );
  const token = passwordLinkToken(await nextMessage(mail, person.email, seen));
  expect(token, `invitation link for ${person.email}`).toBeTruthy();
  const anonymous = await anonymousApi();
  const set = await anonymous.post('/api/auth/password-reset/complete', { data: { token, password } });
  expect(set.status(), `set password for ${person.email}`).toBe(200);
  await anonymous.dispose();
  return added.userId;
}

export interface MemberView {
  userId: string;
  displayName: string;
  email: string;
  status: 'active' | 'invited' | 'suspended';
  roles: string[];
}

export async function member(admin: APIRequestContext, userId: string): Promise<MemberView> {
  return body(await admin.get(`/api/admin/people/${userId}`), 200, `member ${userId}`);
}

/** Suspends a member by API when they are not suspended already; for cleanup. */
export async function suspendQuietly(admin: APIRequestContext, userId: string | undefined): Promise<void> {
  if (!userId) return;
  const r = await admin.get(`/api/admin/people/${userId}`);
  if (!r.ok()) return;
  const m = (await r.json()) as MemberView;
  if (m.status !== 'suspended') await admin.post(`/api/admin/people/${userId}/suspend`);
}

export async function signInStatus(email: string, tenant: string): Promise<number> {
  const anonymous = await anonymousApi();
  const r = await anonymous.post('/api/auth/login', { data: { tenant, email, password } });
  await anonymous.dispose();
  return r.status();
}

// -------------------------------------------------------------------- export

export interface ExportLine {
  table: string;
  row: Record<string, unknown>;
  text: string;
}

/** The whole organisation as `GET /api/admin/export` writes it: one `{ table, row }` per line. */
export async function organisationExport(admin: APIRequestContext): Promise<ExportLine[]> {
  const r = await admin.get('/api/admin/export', { timeout: 120_000 });
  expect(r.status(), 'organisation export').toBe(200);
  return gunzipSync(await r.body())
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((text) => {
      const line = JSON.parse(text) as { table: string; row: Record<string, unknown> };
      return { table: line.table, row: line.row, text: text.toLowerCase() };
    });
}
