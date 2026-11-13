import { expect, request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { accounts, apiBase } from '../accounts.js';
import { memberApi } from '../api.js';
import { label } from '../catalogue.js';

/**
 * Operator journeys: the console (`npm run dev -- --console`), the integration fixture that stands in for the
 * operator identity provider and keeps sent mail, and the organisation app. Set CONSOLE_E2E_URL to run them.
 */
export const consoleBase = process.env.CONSOLE_E2E_URL?.replace(/\/$/, '');
export const operatorEmail = process.env.CONSOLE_E2E_OPERATOR ?? 'operator.full@onengo.local';
export const fixtureBase = (process.env.E2E_FIXTURE_URL ?? 'https://127.0.0.1:8095').replace(/\/$/, '');
export const appBase = (process.env.APP_BASE_URL ?? 'http://localhost:4200').replace(/\/$/, '');

/** Organisations a journey must never suspend or close. */
const PROTECTED = new Set(['riverbank', 'harbour', 'demo']);

export const skipWithoutConsole = 'Set CONSOLE_E2E_URL to a console started with npm run dev -- --console.';
export const mailBlocked =
  'Blocked: the integration fixture mail log is not reachable (set E2E_FIXTURE_URL), so the invitation link cannot be read. The plan (section 7.3) marks mail cases Blocked, not Pass.';

export type LifecycleAction = 'suspend' | 'reactivate' | 'close';

export interface ConsoleAnswer {
  status: number;
  body: { code?: string; message?: string; issues?: { path: string; message: string }[]; [key: string]: unknown } | null;
  text: string;
}

export interface Member {
  code: string;
  email: string;
  name: string;
  password: string;
}

/** One sitting: a browser context the whole journey shares, with the fixture's self-signed certificate accepted. */
export async function journeyContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: appBase, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
}

/** The fixture's operator sign-in page: an email stands in for a fresh multi-factor sign-in. */
export async function throughFixture(page: Page, email = operatorEmail): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Demo sign-in' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function signInToConsole(op: Page, next = '/organisations'): Promise<void> {
  await op.goto(`${consoleBase}/sign-in?next=${encodeURIComponent(next)}`);
  await op.getByRole('button', { name: 'Continue', exact: true }).click();
  await throughFixture(op);
  await op.waitForURL((url) => url.origin === new URL(consoleBase!).origin && !url.pathname.startsWith('/sign-in') && !url.pathname.startsWith('/op/'));
}

/** The visible console navigation (the rail on desktop). */
export function consoleNav(op: Page): Locator {
  return op.getByRole('navigation', { name: 'Console' }).filter({ visible: true });
}

async function onConsole(op: Page): Promise<void> {
  if (!op.url().startsWith(consoleBase!)) await op.goto(`${consoleBase}/organisations`);
}

/** Calls the console API from the console page, with its session cookie and CSRF token, as the console screens do. */
export async function consoleCall(op: Page, method: string, path: string, body?: unknown, raw = false): Promise<ConsoleAnswer> {
  await onConsole(op);
  return op.evaluate(
    async ({ method, path, body, raw }) => {
      const session = (await (await fetch('/op/auth/session', { credentials: 'same-origin' })).json().catch(() => ({}))) as { csrfToken?: string };
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (method !== 'GET' && session.csrfToken) headers['x-csrf-token'] = session.csrfToken;
      const response = await fetch(`/op${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, body: json as ConsoleAnswer['body'], text };
    },
    { method, path, body, raw },
  );
}

export function onboard(op: Page, input: unknown, validateOnly: boolean): Promise<ConsoleAnswer> {
  return consoleCall(op, 'POST', '/organisations/onboard', { input, validateOnly });
}

export function organisationStatus(op: Page, ref: { code?: string; requestId?: string }): Promise<ConsoleAnswer> {
  const query = new URLSearchParams(Object.entries(ref).filter((entry): entry is [string, string] => !!entry[1]));
  return consoleCall(op, 'GET', `/organisations/status?${query}`);
}

/** Field paths of a refused onboarding request. */
export function issuePaths(answer: ConsoleAnswer): string[] {
  return (answer.body?.issues ?? []).map((issue) => issue.path);
}

export function expectValid(answer: ConsoleAnswer, what: string): void {
  expect(answer.status, `${what} is accepted: ${answer.text}`).toBe(200);
  expect(answer.body?.['status'], what).toBe('valid');
}

export function expectRefused(answer: ConsoleAnswer, path: string, what: string): void {
  expect(answer.status, `${what} is refused`).toBe(400);
  expect(answer.body?.code, what).toBe('validation_failed');
  expect(issuePaths(answer).some((p) => p === path || p.startsWith(`${path}.`) || p.startsWith(`${path}[`)), `${what} names ${path}: ${answer.text}`).toBe(true);
}

/** The year label the console proposes for a start month. */
export function currentFiscalYear(startMonth: number, today = new Date()): string {
  const year = today.getFullYear();
  if (startMonth === 1) return String(year);
  const startYear = today.getMonth() + 1 >= startMonth ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

/** The Riverbank request from the manual test plan, section 4, with this run's request id, code, and administrator. */
export function riverbankRequest(opts: { requestId: string; code: string; displayName: string; adminName: string; adminEmail: string }) {
  return {
    requestId: opts.requestId,
    organisation: {
      code: opts.code,
      displayName: opts.displayName,
      legalName: 'Riverbank Charitable Trust',
      contact: { email: 'office@riverbank.example', phone: '+91 80 4000 1200' },
      address: { line1: '12 Lake Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: 'IN' },
      timezone: 'Asia/Kolkata',
      defaultLanguage: 'en',
      region: 'asia-south1',
    },
    administrator: { name: opts.adminName, email: opts.adminEmail },
    modules: ['donations'],
    financialYear: { startMonth: 4, current: currentFiscalYear(4) },
    receiptPrefix: 'RCPT',
  };
}

// ------------------------------------------------------------------ step-up and lifecycle

/** Asks for a one-use step-up for an action on an organisation, completes it at the fixture, and returns its id. */
export async function stepUp(op: Page, action: LifecycleAction, code: string): Promise<string> {
  const returnPath = `/organisations/status?code=${encodeURIComponent(code)}`;
  const answer = await consoleCall(op, 'POST', '/auth/step-up', { action, target: code, returnPath });
  expect(answer.status, `step-up for ${action}: ${answer.text}`).toBe(200);
  await op.goto(String(answer.body?.['redirect']));
  await throughFixture(op);
  await op.waitForURL(/stepUpId=/);
  return new URL(op.url()).searchParams.get('stepUpId')!;
}

/** A lifecycle call straight to the console API, after its own step-up. */
export async function lifecycleCall(op: Page, action: LifecycleAction, code: string, reason: string): Promise<ConsoleAnswer> {
  guard(code);
  const stepUpId = await stepUp(op, action, code);
  return consoleCall(op, 'POST', `/organisations/${encodeURIComponent(code)}/${action}`, { reason, stepUpId });
}

export function guard(code: string): void {
  if (PROTECTED.has(code)) throw new Error(`The journey must not change the lifecycle of ${code}.`);
}

export async function openStatus(op: Page, code: string): Promise<void> {
  await op.goto(`${consoleBase}/organisations/status?code=${encodeURIComponent(code)}`);
  await expect(statusBadge(op)).toBeVisible();
}

export function statusBadge(op: Page): Locator {
  return op.locator('.pagehead .badge');
}

const ACTION_BUTTON: Record<LifecycleAction, string> = { suspend: 'Suspend', reactivate: 'Reactivate', close: 'Close' };

/**
 * Suspend, Reactivate, or Close on the status screen: the first Confirm leaves for a fresh check at the provider;
 * back on the screen the reason is typed and Confirm finishes. Returns the reason field as it stood on return.
 */
export async function lifecycleInConsole(op: Page, code: string, action: LifecycleAction, reason: string): Promise<{ reasonOnReturn: string }> {
  guard(code);
  await openStatus(op, code);
  await op.getByRole('button', { name: ACTION_BUTTON[action], exact: true }).click();
  const sheet = op.locator('section.sheet');
  await expect(sheet.getByRole('heading', { name: action })).toBeVisible();
  // The reason and the typed code sit inside their labels, so they are found by their form names.
  const confirmCode = sheet.locator('input[name="confirm"]');
  if (action === 'close') {
    await expect(sheet.getByText(`Type ${code} to confirm`)).toBeVisible();
    await confirmCode.fill(code);
  }
  await sheet.getByRole('button', { name: 'Confirm', exact: true }).click();
  await throughFixture(op);
  await op.waitForURL(/stepUpId=/);
  await expect(op.getByText('Verification is complete. Confirm to finish.')).toBeVisible();
  const reasonField = sheet.locator('textarea[name="reason"]');
  const reasonOnReturn = await reasonField.inputValue();
  await reasonField.fill(reason);
  if (action === 'close') await confirmCode.fill(code);
  await sheet.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  return { reasonOnReturn };
}

// ------------------------------------------------------------------ organisation app

/** The member's password sign-in on the organisation's own page, without clearing the operator's cookie. */
export async function signInMember(page: Page, member: Member): Promise<void> {
  await page.goto(`${appBase}/o/${member.code}/sign-in`);
  await page.getByRole('tab', { name: label('ui.auth.tabPassword') }).click();
  await page.getByLabel(label('ui.auth.email')).fill(member.email);
  await page.getByLabel(label('ui.auth.password')).fill(member.password);
  await page.getByRole('button', { name: label('ui.auth.signIn'), exact: true }).click();
  await expect(page.getByText(label('ui.home.welcome', { name: member.name }))).toBeVisible();
}

export interface ApiSignIn {
  status: number;
  accessToken?: string;
  refreshToken?: string;
}

/** Password sign-in through the API: the access token, and the refresh token from its cookie. */
export async function apiSignIn(member: Member): Promise<ApiSignIn> {
  const anonymous = await playwrightRequest.newContext({ baseURL: apiBase });
  try {
    const response = await anonymous.post('/api/auth/login', { data: { tenant: member.code, email: member.email, password: member.password } });
    if (response.status() !== 200) return { status: response.status() };
    const { accessToken } = (await response.json()) as { accessToken: string };
    const cookie = response.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('ngo_rt='));
    const refreshToken = cookie ? decodeURIComponent(cookie.value.split(';')[0]!.slice('ngo_rt='.length)) : undefined;
    return { status: 200, accessToken, refreshToken };
  } finally {
    await anonymous.dispose();
  }
}

export async function bearerApi(accessToken: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: apiBase, extraHTTPHeaders: { authorization: `Bearer ${accessToken}` } });
}

/** Uses a refresh token the way the app does: the `ngo_rt` cookie on POST /api/auth/refresh. */
export async function refreshWith(refreshToken: string): Promise<number> {
  const anonymous = await playwrightRequest.newContext({ baseURL: apiBase });
  try {
    return (await anonymous.post('/api/auth/refresh', { headers: { cookie: `ngo_rt=${encodeURIComponent(refreshToken)}` } })).status();
  } finally {
    await anonymous.dispose();
  }
}

/** A Viewer API key made by the administrator; the token is `<id>.<secret>`. */
export async function createApiKey(admin: APIRequestContext, name: string): Promise<string> {
  const response = await admin.post('/api/admin/api-keys', { data: { name, role: 'viewer' } });
  expect(response.status(), `create API key ${name}`).toBeLessThan(300);
  return ((await response.json()) as { token: string }).token;
}

export async function keyQuery(token: string): Promise<number> {
  const anonymous = await playwrightRequest.newContext({ baseURL: apiBase });
  try {
    return (await anonymous.post('/api/records/donor/query', { headers: { authorization: `ApiKey ${token}` }, data: {} })).status();
  } finally {
    await anonymous.dispose();
  }
}

/** The public organisation lookup the sign-in page makes, timed. */
export async function lookup(code: string): Promise<{ status: number; message: string; ms: number }> {
  const anonymous = await playwrightRequest.newContext({ baseURL: apiBase });
  try {
    const started = Date.now();
    const response = await anonymous.get(`/api/auth/organisations/${encodeURIComponent(code)}`);
    const ms = Date.now() - started;
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    return { status: response.status(), message: body.message ?? '', ms };
  } finally {
    await anonymous.dispose();
  }
}

// ------------------------------------------------------------------ mail kept by the fixture

export interface MailSummary {
  id: number;
  at: string;
  to: string[];
  subject: string;
}

async function fixture(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: fixtureBase, ignoreHTTPSErrors: true });
}

export async function mailAvailable(): Promise<boolean> {
  const api = await fixture();
  try {
    return (await api.get('/api/log', { timeout: 5_000 })).ok();
  } catch {
    return false;
  } finally {
    await api.dispose();
  }
}

export async function mailsTo(email: string): Promise<MailSummary[]> {
  const api = await fixture();
  try {
    const { messages } = (await (await api.get('/api/log')).json()) as { messages: MailSummary[] };
    return messages.filter((m) => m.to.some((to) => to.toLowerCase() === email.toLowerCase()));
  } finally {
    await api.dispose();
  }
}

export async function mailText(id: number): Promise<string> {
  const api = await fixture();
  try {
    return decodeMime(await (await api.get(`/mail/${id}`)).text());
  } finally {
    await api.dispose();
  }
}

/** Quoted-printable and base64 parts both decoded, so a link can be found whichever the mailer chose. */
function decodeMime(raw: string): string {
  const qp = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const blocks = raw.split(/\r?\n\r?\n/).filter((block) => /^[A-Za-z0-9+/=\r\n]{16,}$/.test(block.trim()));
  const decoded = blocks.map((block) => Buffer.from(block.replace(/\s+/g, ''), 'base64').toString('utf8'));
  return [Buffer.from(qp, 'latin1').toString('utf8'), ...decoded].join('\n');
}

export interface PasswordLink {
  token: string;
  org: string;
  kind: string;
  /** The same link on the organisation app, which the invitation's API address stands in for locally. */
  appUrl: string;
}

/** Every distinct set-password link in a message. */
export function passwordLinks(text: string): PasswordLink[] {
  const found = new Map<string, PasswordLink>();
  for (const match of text.matchAll(/\/reset-password\?([^\s"'<>]+)/g)) {
    const query = new URLSearchParams(match[1]!.replace(/&amp;/g, '&'));
    const token = query.get('token');
    if (!token || found.has(token)) continue;
    found.set(token, { token, org: query.get('org') ?? '', kind: query.get('kind') ?? '', appUrl: `${appBase}/reset-password?${query}` });
  }
  return [...found.values()];
}

/** Waits for the invitation mail to arrive and returns its one link. */
export async function invitationFor(email: string): Promise<{ mail: MailSummary; link: PasswordLink }> {
  let mail: MailSummary | undefined;
  await expect
    .poll(async () => {
      mail = (await mailsTo(email)).find((m) => /invited/i.test(m.subject));
      return !!mail;
    }, { message: `invitation mail to ${email}`, timeout: 30_000 })
    .toBe(true);
  const links = passwordLinks(await mailText(mail!.id));
  expect(links.length, 'one set-password link in the invitation').toBe(1);
  return { mail: mail!, link: links[0]! };
}

/** Sets the invited member's password through the same API the set-password page calls. */
export async function acceptInvitation(link: PasswordLink, password: string): Promise<void> {
  const anonymous = await playwrightRequest.newContext({ baseURL: apiBase });
  try {
    const response = await anonymous.post('/api/auth/password-reset/complete', { data: { token: link.token, password } });
    expect(response.status(), `set the invited password: ${await response.text()}`).toBe(200);
  } finally {
    await anonymous.dispose();
  }
}

/**
 * A Riverbank invitation that no journey depends on, for password-rule checks that might be accepted by mistake.
 * Asha (seeded administrator) adds a person with no role; the name keeps Asha's words so the name rule applies,
 * in an order that does not match searches for "Asha Menon".
 */
export interface Throwaway {
  userId: string;
  /** True when the person had to be given `noaccess` because a person with no role was refused. */
  fallbackRole: boolean;
}

export async function throwawayInvitation(
  tag: string,
  created: Throwaway[],
): Promise<{ person: { email: string; name: string }; link: PasswordLink }> {
  const person = { email: `asha${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}@riverbank.example`, name: `Menon Asha ${tag}` };
  const admin = await memberApi(accounts.admin.email);
  try {
    let fallbackRole = false;
    let added = await admin.post('/api/admin/people', { data: { email: person.email, displayName: person.name, roles: [], invite: true } });
    if (added.status() === 400 || added.status() === 422) {
      fallbackRole = true;
      added = await admin.post('/api/admin/people', { data: { email: person.email, displayName: person.name, roles: ['noaccess'], invite: true } });
    }
    expect(added.status(), `add throwaway invitee: ${await added.text()}`).toBeLessThan(300);
    created.push({ userId: ((await added.json()) as { userId: string }).userId, fallbackRole });
  } finally {
    await admin.dispose();
  }
  return { person, link: (await invitationFor(person.email)).link };
}

/** Takes the throwaway invitees out of Riverbank's Active list: the fallback role removed, then suspended. */
export async function retireThrowaways(created: Throwaway[]): Promise<void> {
  if (!created.length) return;
  const admin = await memberApi(accounts.admin.email);
  try {
    for (const person of created.splice(0)) {
      const path = `/api/admin/people/${encodeURIComponent(person.userId)}`;
      // The server may refuse an empty role list, as it did when this person was added; suspending still retires them.
      if (person.fallbackRole) await admin.put(`${path}/roles`, { data: { roles: [] } });
      const suspended = await admin.post(`${path}/suspend`);
      if (suspended.status() !== 409) expect(suspended.status(), `suspend ${person.userId}: ${await suspended.text()}`).toBeLessThan(300);
    }
  } finally {
    await admin.dispose();
  }
}

// ------------------------------------------------------------------ disposable organisations

/**
 * An organisation the journey may suspend or close: read from an env var, or provisioned fresh with its
 * administrator's password set from the invitation. `member` is null when the invitation could not be read.
 */
export async function disposableOrganisation(op: Page, envPrefix: string, tag: string): Promise<{ code: string; member: Member | null } | null> {
  const code = process.env[`${envPrefix}_ORG`];
  if (code) {
    guard(code);
    const email = process.env[`${envPrefix}_EMAIL`];
    const memberPassword = process.env[`${envPrefix}_PASSWORD`] ?? process.env.E2E_PASSWORD ?? 'Password@01';
    return { code, member: email ? { code, email, name: process.env[`${envPrefix}_NAME`] ?? email, password: memberPassword } : null };
  }
  const fresh = tag.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const request = riverbankRequest({
    requestId: `disposable-${fresh}`,
    code: `dsp-${fresh}`.slice(0, 40),
    displayName: `Disposable Trust ${fresh}`,
    adminName: 'Disposable Admin',
    adminEmail: `admin.${fresh}@disposable.example`,
  });
  const made = await onboard(op, request, false);
  if (made.status !== 200 || made.body?.['status'] !== 'active') return null;
  const member: Member = { code: request.organisation.code, email: request.administrator.email, name: request.administrator.name, password: 'quiet harbour lamp seventeen' };
  if (!(await mailAvailable())) return { code: member.code, member: null };
  await acceptInvitation((await invitationFor(member.email)).link, member.password);
  return { code: member.code, member };
}

/** True when the locator becomes visible within the time; for deciding whether a known defect is showing. */
export async function appears(locator: Locator, timeout = 3_000): Promise<boolean> {
  return locator.first().waitFor({ state: 'visible', timeout }).then(
    () => true,
    () => false,
  );
}
