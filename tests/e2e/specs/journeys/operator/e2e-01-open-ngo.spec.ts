import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { runTag } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import { knownDefect, openDestination } from '../../../src/shell.js';
import { signIn } from '../../../src/sign-in.js';
import {
  apiSignIn,
  appBase,
  appears,
  bearerApi,
  consoleBase,
  consoleCall,
  consoleNav,
  currentFiscalYear,
  expectRefused,
  expectValid,
  invitationFor,
  journeyContext,
  mailAvailable,
  mailBlocked,
  mailsTo,
  mailText,
  onboard,
  organisationStatus,
  passwordLinks,
  riverbankRequest,
  signInMember,
  signInToConsole,
  skipWithoutConsole,
  retireThrowaways,
  throwawayInvitation,
  type Member,
  type Throwaway,
  type PasswordLink,
} from '../../../src/journeys/operator.js';

/**
 * FT-E2E-01: the full operator validates and provisions a fresh Riverbank request, the invited administrator sets
 * a password, finishes setup, and invites Finance and Viewer. Runs as one sitting: one browser context with the
 * console tab (`op`) and the organisation app tab (`app`).
 */
const run = runTag('e2e01').split('-')[1]!;
const code = `rb-${run}`;
const requestId = `riverbank-${run}`;
const displayName = `Riverbank Trust ${run}`;
const admin: Member = { code, email: `asha${run}@riverbank.example`, name: 'Asha Menon', password: 'quiet river lantern morning' };
const finance = { email: `finance${run}@riverbank.example`, name: `Finance ${run}` };
const viewer = { email: `viewer${run}@riverbank.example`, name: `Viewer ${run}` };
const registration = { type: '80g', number: `AAATR${run.slice(0, 4).toUpperCase()}F` };

/** The valid request with one change, for the one-broken-rule drafts. */
function draft(change: (input: any) => void): Record<string, unknown> {
  const input = structuredClone(riverbankRequest({ requestId, code, displayName, adminName: admin.name, adminEmail: admin.email }));
  change(input);
  return input;
}

const SMOKE = ['@e2e', '@FT-E2E-01', '@P0', '@smoke'];
const P0 = ['@e2e', '@FT-E2E-01', '@P0'];
const P1 = ['@e2e', '@FT-E2E-01', '@P1'];
const P2 = ['@e2e', '@FT-E2E-01', '@P2'];

const SETUP_KEYS = ['identity', 'registrations', 'fiscalYear', 'receiptSeries', 'operationalRole', 'email', 'payments'] as const;
const SETUP_LINKS: Record<(typeof SETUP_KEYS)[number], string> = {
  identity: '/admin/organisation/profile',
  registrations: '/admin/organisation/registrations',
  fiscalYear: '/admin/organisation/settings',
  receiptSeries: '/builder?section=money&kind=receiptRule',
  operationalRole: '/admin/roles',
  email: '/admin/connectors',
  payments: '/admin/connectors',
};

/**
 * Refusals that change nothing: one-broken-rule onboarding drafts (validate only) and the password rules on a
 * throwaway Riverbank invitation. Each reports on its own, so a plan-versus-build mismatch here does not skip the
 * stateful journey below. The administrator's own invitation is used only by FT-AUTH-065 and FT-AUTH-066.
 */
test.describe('FT-E2E-01 Open a new NGO: refusals that change nothing', () => {
  test.describe.configure({ timeout: 120_000 });

  let context: BrowserContext | undefined;
  let op: Page;
  /** Invitees added to Riverbank for the password rules; suspended again once the block ends. */
  const throwaways: Throwaway[] = [];

  test.beforeEach(async ({ browser }) => {
    const id = test.info().title.split(' ')[0]!;
    test.skip(id.startsWith('FT-OPC') && !consoleBase, skipWithoutConsole);
    if (!id.startsWith('FT-OPC') || context) return;
    context = await journeyContext(browser);
    op = await context.newPage();
    await signInToConsole(op);
  });

  test.afterAll(async () => {
    try {
      await retireThrowaways(throwaways);
    } finally {
      await context?.close();
    }
  });

  test('FT-OPC-064 invalid JSON gets a clear parse error and nothing can be provisioned', { tag: P2 }, async () => {
    const answer = await consoleCall(op, 'POST', '/organisations/onboard', '{"input": {"requestId": ', true);
    expect(answer.status).toBe(400);
    expect(answer.body?.message ?? '').toMatch(/JSON/i);
    await op.goto(`${consoleBase}/organisations/onboard`);
    await expect(op.getByRole('heading', { name: 'Onboard an organisation' })).toBeVisible();
    await expect(op.getByRole('button', { name: /^Onboard / })).toHaveCount(0);
  });

  test('FT-OPC-041 a request id of 2 or 101 characters is refused, and 3 or 100 is accepted', { tag: P1 }, async () => {
    expectRefused(await onboard(op, draft((d) => (d.requestId = 'ab')), true), 'requestId', 'request id of 2');
    expectRefused(await onboard(op, draft((d) => (d.requestId = 'r'.repeat(101))), true), 'requestId', 'request id of 101');
    expectValid(await onboard(op, draft((d) => (d.requestId = 'r1x')), true), 'request id of 3');
    expectValid(await onboard(op, draft((d) => (d.requestId = `r${run}`.padEnd(100, 'x'))), true), 'request id of 100');
  });

  test('FT-OPC-042 a request id starting with a dot or holding a space or slash is refused', { tag: P1 }, async () => {
    for (const bad of [`.${requestId}`, `river bank-${run}`, `river/${run}`]) {
      expectRefused(await onboard(op, draft((d) => (d.requestId = bad)), true), 'requestId', `request id ${bad}`);
    }
  });

  test('FT-OPC-043 a code of 2 or 41 characters is refused, and 3 or 40 is accepted', { tag: P0 }, async () => {
    expectRefused(await onboard(op, draft((d) => (d.organisation.code = 'ab')), true), 'organisation.code', 'code ab');
    expectValid(await onboard(op, draft((d) => (d.organisation.code = 'abc')), true), 'code abc');
    expectValid(await onboard(op, draft((d) => (d.organisation.code = `x${run}`.padEnd(40, 'a'))), true), 'code of 40');
    expectRefused(await onboard(op, draft((d) => (d.organisation.code = `x${run}`.padEnd(41, 'a'))), true), 'organisation.code', 'code of 41');
  });

  test('FT-OPC-044 codes with capitals, edge or double dashes, a leading digit, or an underscore are refused', { tag: P1 }, async () => {
    for (const bad of ['RiverBank', '-river', 'river-', 'river--bank', '1river', 'river_bank']) {
      expectRefused(await onboard(op, draft((d) => (d.organisation.code = bad)), true), 'organisation.code', `code ${bad}`);
    }
  });

  test('FT-OPC-045 each reserved code is refused', { tag: P1 }, async () => {
    for (const reserved of ['admin', 'api', 'app', 'internal', 'onengo', 'operator', 'sign-in', 'support', 'www']) {
      const answer = await onboard(op, draft((d) => (d.organisation.code = reserved)), true);
      expectRefused(answer, 'organisation.code', `reserved code ${reserved}`);
      expect(answer.body?.issues?.find((i) => i.path === 'organisation.code')?.message).toMatch(/reserved/);
    }
  });

  test('FT-OPC-046 a code another organisation uses is refused as taken', { tag: P1 }, async () => {
    const answer = await onboard(op, draft((d) => (d.organisation.code = 'riverbank')), true);
    expectRefused(answer, 'organisation.code', 'code riverbank');
    expect(answer.body?.issues?.map((i) => i.message)).toContain('Another organisation or onboarding request already uses this code.');
  });

  test('FT-OPC-047 names over their limits are refused', { tag: P1 }, async () => {
    expectValid(await onboard(op, draft((d) => (d.organisation.displayName = 'D'.repeat(120))), true), 'display name of 120');
    expectRefused(await onboard(op, draft((d) => (d.organisation.displayName = 'D'.repeat(121))), true), 'organisation.displayName', 'display name of 121');
    expectValid(await onboard(op, draft((d) => (d.organisation.legalName = 'L'.repeat(200))), true), 'legal name of 200');
    expectRefused(await onboard(op, draft((d) => (d.organisation.legalName = 'L'.repeat(201))), true), 'organisation.legalName', 'legal name of 201');
    expectValid(await onboard(op, draft((d) => (d.administrator.name = 'A'.repeat(120))), true), 'administrator name of 120');
    expectRefused(await onboard(op, draft((d) => (d.administrator.name = 'A'.repeat(121))), true), 'administrator.name', 'administrator name of 121');
  });

  test('FT-OPC-048 a malformed or 255-character administrator email is refused', { tag: P1 }, async () => {
    for (const bad of ['asha@', 'asha.example', `${'a'.repeat(243)}@example.org`]) {
      expectRefused(await onboard(op, draft((d) => (d.administrator.email = bad)), true), 'administrator.email', `email of ${bad.length} characters`);
    }
  });

  test('FT-OPC-049 a contact phone of 5 or 21 characters, or with letters, is refused; the bracketed form is accepted', { tag: P1 }, async () => {
    for (const bad of ['12345', '+91 80 4000 1200 1234', '+91 80 RIVER BANK']) {
      expectRefused(await onboard(op, draft((d) => (d.organisation.contact.phone = bad)), true), 'organisation.contact.phone', `phone ${bad}`);
    }
    expectValid(await onboard(op, draft((d) => (d.organisation.contact.phone = '+91 (80) 4000-1200')), true), 'bracketed phone');
  });

  test('FT-OPC-050 a country that is not a two-letter capital code is refused; IN is accepted', { tag: P1 }, async () => {
    for (const bad of ['India', 'in', 'IND']) {
      expectRefused(await onboard(op, draft((d) => (d.organisation.address.country = bad)), true), 'organisation.address.country', `country ${bad}`);
    }
    expectValid(await onboard(op, draft((d) => (d.organisation.address.country = 'IN')), true), 'country IN');
  });

  test('FT-OPC-051 a time zone that is not an IANA name is refused; Asia/Kolkata is accepted', { tag: P1 }, async () => {
    for (const bad of ['Kolkata', 'IST', 'UTC+5:30']) {
      expectRefused(await onboard(op, draft((d) => (d.organisation.timezone = bad)), true), 'organisation.timezone', `time zone ${bad}`);
    }
    expectValid(await onboard(op, draft((d) => (d.organisation.timezone = 'Asia/Kolkata')), true), 'time zone Asia/Kolkata');
  });

  test('FT-OPC-052 a language the product does not ship is refused; the six shipped languages are accepted', { tag: P1 }, async () => {
    for (const bad of ['fr', 'EN', 'hi-IN']) {
      expectRefused(await onboard(op, draft((d) => (d.organisation.defaultLanguage = bad)), true), 'organisation.defaultLanguage', `language ${bad}`);
    }
    for (const good of ['en', 'hi', 'ta', 'te', 'bn', 'mr']) {
      expectValid(await onboard(op, draft((d) => (d.organisation.defaultLanguage = good)), true), `language ${good}`);
    }
  });

  test('FT-OPC-053 a region with a capital, a leading digit, or 41 characters is refused', { tag: P2 }, async () => {
    for (const bad of ['Asia-South1', '1asia', 'a'.repeat(41)]) {
      expectRefused(await onboard(op, draft((d) => (d.organisation.region = bad)), true), 'organisation.region', `region ${bad}`);
    }
  });

  test('FT-OPC-054 a financial year label that does not match its start month is refused', { tag: P1 }, async () => {
    const refused: [number, string, string][] = [
      [4, '2026', 'financialYear.current'],
      [1, '2026-27', 'financialYear.current'],
      [0, '2026-27', 'financialYear.startMonth'],
      [13, '2026-27', 'financialYear.startMonth'],
    ];
    for (const [startMonth, current, path] of refused) {
      expectRefused(await onboard(op, draft((d) => (d.financialYear = { startMonth, current })), true), path, `year ${current} from month ${startMonth}`);
    }
    expectValid(await onboard(op, draft((d) => (d.financialYear = { startMonth: 1, current: '2026' })), true), 'year 2026 from January');
    expectValid(await onboard(op, draft((d) => (d.financialYear = { startMonth: 4, current: '2026-27' })), true), 'year 2026-27 from April');
  });

  test('FT-OPC-055 receipt prefixes in lower case, with a slash or leading dash, or of 13 characters are refused; 12 is accepted', { tag: P1 }, async () => {
    for (const bad of ['rcpt', 'RC/PT', '-RCPT', 'R'.repeat(13)]) {
      expectRefused(await onboard(op, draft((d) => (d.receiptPrefix = bad)), true), 'receiptPrefix', `receipt prefix ${bad}`);
    }
    expectValid(await onboard(op, draft((d) => (d.receiptPrefix = 'R'.repeat(12))), true), 'receipt prefix of 12');
  });

  test('FT-OPC-056 a receipt prefix with no module is refused because nothing issues receipts', { tag: P1 }, async () => {
    const answer = await onboard(op, draft((d) => (d.modules = [])), true);
    expectRefused(answer, 'receiptPrefix', 'receipt prefix with no module');
    expect(answer.body?.issues?.map((i) => i.message)).toContain('None of the modules issues receipts.');
  });

  test('FT-OPC-057 twenty registrations are accepted and twenty-one are refused', { tag: P1 }, async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ type: '80g', number: `REG${run}${i}`.toUpperCase() }));
    expectValid(await onboard(op, draft((d) => (d.organisation.registrations = rows(20))), true), '20 registrations');
    expectRefused(await onboard(op, draft((d) => (d.organisation.registrations = rows(21))), true), 'organisation.registrations', '21 registrations');
  });

  test('FT-OPC-058 two registrations with the same type and number are refused as a duplicate', { tag: P1 }, async () => {
    const answer = await onboard(op, draft((d) => (d.organisation.registrations = [{ type: '12a', number: 'AB123' }, { type: '12a', number: 'ab123' }])), true);
    expectRefused(answer, 'organisation.registrations', 'duplicate registration');
    expect(answer.body?.issues?.map((i) => i.message)).toContain('This registration is listed twice.');
  });

  test('FT-OPC-059 an unknown module, a repeated module, or 21 modules are refused', { tag: P1 }, async () => {
    expectRefused(await onboard(op, draft((d) => (d.modules = ['nosuchmodule'])), true), 'modules', 'unknown module');
    expectRefused(await onboard(op, draft((d) => (d.modules = ['donations', 'donations'])), true), 'modules', 'repeated module');
    expectRefused(await onboard(op, draft((d) => (d.modules = Array.from({ length: 21 }, () => 'donations'))), true), 'modules', '21 modules');
  });

  test('FT-OPC-060 a module without its dependency names the missing module', { tag: P2 }, async () => {
    test.skip(true, 'No shipped module declares dependsOn (packages/product/modules has only donations), so there is no request to build. The plan says skip.');
  });

  test('FT-OPC-061 problems are listed per field and registration numbers are not echoed back', { tag: P1 }, async () => {
    const secret = `SECRET${run}`.toUpperCase();
    const answer = await onboard(
      op,
      draft((d) => {
        d.organisation.registrations = [{ type: 'fcra', number: secret }];
        d.organisation.address.country = 'India';
        d.organisation.timezone = 'Kolkata';
      }),
      true,
    );
    expect(answer.status).toBe(400);
    expect(answer.body?.issues?.map((i) => i.path)).toEqual(expect.arrayContaining(['organisation.address.country', 'organisation.timezone']));
    expect(answer.text).not.toContain(secret);
    expect(answer.text.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  test('FT-OPC-062 a request carrying a password field is refused as an unknown property', { tag: P1 }, async () => {
    const top = await onboard(op, draft((d) => (d.password = 'quiet lake path nineteen')), true);
    expectRefused(top, 'password', 'top-level password');
    const nested = await onboard(op, draft((d) => ((d.administrator as Record<string, unknown>).password = 'quiet lake path nineteen')), true);
    expectRefused(nested, 'administrator.password', 'administrator password');
    expect(nested.body?.issues?.find((i) => i.path === 'administrator.password')?.message).toBe('Not a known property.');
  });

  // ---------------------------------------------------------------- Password rules, on throwaway invitations

  /** A fresh Riverbank invitation for this test alone, opened on the set-password page. */
  const openThrowaway = async (page: Page, n: string) => {
    test.skip(!(await mailAvailable()), mailBlocked);
    const throwaway = await throwawayInvitation(`${run}${n}`, throwaways);
    await page.goto(throwaway.link.appUrl);
    await expect(page.getByRole('heading', { name: label('ui.reset.inviteTitle'), level: 1 })).toBeVisible();
    return throwaway;
  };
  const tryPassword = async (page: Page, value: string, again = value) => {
    await page.getByLabel(label('ui.reset.newPassword')).fill(value);
    await page.getByLabel(label('ui.reset.again')).fill(again);
    await page.getByRole('button', { name: label('ui.reset.save'), exact: true }).click();
  };
  const refusal = (page: Page) => page.getByRole('alert');

  test('FT-AUTH-040 9 and 201 characters are refused, and 10 and 200 pass the length rule', { tag: P1 }, async ({ page }) => {
    await openThrowaway(page, 'l');
    await tryPassword(page, 'a quiet sentence about the lake '.repeat(7).slice(0, 201));
    await expect(refusal(page)).toHaveText('Password is too long.');
    // These fail a later rule, which shows the length rule let them through.
    await tryPassword(page, 'ashamenon1');
    await expect(refusal(page)).toHaveText('Do not build your password around your name, email, or organisation.');
    await tryPassword(page, 'ab'.repeat(100));
    await expect(refusal(page)).toHaveText(/^This password is too easy to guess/);

    await tryPassword(page, 'quietlake');
    if (!(await appears(refusal(page).filter({ hasText: 'Use at least 10 characters.' })))) {
      knownDefect('DEF-01', 'A 9-character password is not saved but no "Use at least 10 characters." error appears.');
    }
    await expect(refusal(page)).toHaveText('Use at least 10 characters.');
  });

  test('FT-AUTH-041 common passwords and simple sequences are refused as too easy to guess', { tag: P1 }, async ({ page }) => {
    await openThrowaway(page, 'w');
    for (const weak of ['password1234', 'abcdefghij', '1111111111', 'qwertyuiop', 'abcabcabca']) {
      await tryPassword(page, weak);
      await expect(refusal(page), weak).toHaveText(/^This password is too easy to guess/);
    }
  });

  test('FT-AUTH-042 a password built around the name, email, or organisation is refused', { tag: P1 }, async ({ page }) => {
    const { person } = await openThrowaway(page, 'b');
    for (const built of ['ashamenon12', 'riverbank99x', `${person.email.split('@')[0]}x7k2q`]) {
      await tryPassword(page, built);
      await expect(refusal(page), built).toHaveText('Do not build your password around your name, email, or organisation.');
    }
  });

  test('FT-AUTH-043 the name plus exactly six other characters is accepted, and sign-in works with it', { tag: P1 }, async ({ page }) => {
    const { person, link } = await openThrowaway(page, 'n');
    await tryPassword(page, 'Ashaqz7wm4');
    await expect(page.getByText(label('ui.reset.done'))).toBeVisible();
    await expect(page.getByRole('link', { name: label('ui.reset.goToSignIn') })).toHaveAttribute('href', `/o/${link.org}/sign-in`);
    expect((await apiSignIn({ code: link.org, email: person.email, name: person.name, password: 'Ashaqz7wm4' })).status, 'sign-in with the new password').toBe(200);
  });

  test('FT-AUTH-046 two different passwords say they do not match and send nothing', { tag: P1 }, async ({ page }) => {
    await openThrowaway(page, 'm');
    let sent = 0;
    const count = (r: { url(): string }) => {
      if (r.url().includes('/api/auth/password-reset/complete')) sent += 1;
    };
    page.on('request', count);
    await tryPassword(page, 'quiet lake path nineteen', 'quiet lake path twenty');
    await expect(refusal(page)).toHaveText(label('ui.reset.mismatch'));
    page.off('request', count);
    expect(sent, 'no request sent').toBe(0);
  });
});

test.describe.serial('FT-E2E-01 Open a new NGO', () => {
  test.skip(!consoleBase, skipWithoutConsole);
  test.describe.configure({ timeout: 120_000 });

  let context: BrowserContext;
  let op: Page;
  let app: Page;
  let mailOk = false;
  let provisioned: Record<string, unknown> | undefined;
  let invite: PasswordLink | undefined;

  test.beforeAll(async ({ browser }) => {
    context = await journeyContext(browser);
    op = await context.newPage();
    app = await context.newPage();
    mailOk = await mailAvailable();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  const openChecklist = async () => {
    await app.goto('/admin');
    await app.getByRole('button', { name: label('ui.admin.organisation.setupView'), exact: true }).click();
    return app.getByRole('dialog', { name: label('ui.admin.organisation.setupTitle') });
  };
  const setupRow = (dialog: Locator, key: (typeof SETUP_KEYS)[number]) =>
    dialog.locator('.admin__row').filter({ hasText: label(`ui.admin.organisation.setup.${key}`) });

  // ---------------------------------------------------------------- Sign in to the console

  test('FT-OPC-001 the full operator signs in with a fresh multi-factor check and Find opens', { tag: SMOKE }, async () => {
    const appSession = async () => (await context.cookies(appBase)).find((c) => c.name === 'ngo_rt')?.value ?? null;
    const before = await appSession();
    await signInToConsole(op);
    await expect(op.getByRole('heading', { name: 'Organisations', level: 1 })).toBeVisible();
    const cookie = (await context.cookies(consoleBase!)).find((c) => c.name === '__Host-ngo_operator');
    expect(cookie, 'operator session cookie').toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.secure).toBe(true);
    expect(cookie!.sameSite).toBe('Strict');
    expect(await appSession(), 'the organisation-app session is unchanged').toBe(before);
  });

  test('FT-OPC-003 the public console address, signed out, says two-factor authentication is required', { tag: P1 }, async ({ browser }) => {
    const signedOut = await journeyContext(browser);
    try {
      const page = await signedOut.newPage();
      await page.goto(consoleBase!);
      await expect(page).toHaveURL(/\/sign-in/);
      await expect(page.getByText(/Two-factor authentication is required/)).toBeVisible();
      if ((await page.title()) === 'NGOOne') knownDefect('C-03', 'The console tab title is "NGOOne"; the plan expects One NGO Console. The product name is an open document conflict.');
      await expect(page).toHaveTitle('One NGO Console');
    } finally {
      await signedOut.close();
    }
  });

  test('FT-OPC-014 after sign-out, Back returns protected pages to sign-in', { tag: P1 }, async () => {
    await op.goto(`${consoleBase}/organisations`);
    await consoleNav(op).getByRole('button', { name: 'Sign out', exact: true }).click();
    const confirm = op.getByRole('alertdialog', { name: 'Sign out?' });
    await expect(confirm.getByText('You will be signed out on this device and will need to sign in again.')).toBeVisible();
    await confirm.getByRole('button', { name: 'Sign out', exact: true }).click();
    await op.waitForURL(/\/sign-in/);
    await op.goBack();
    await expect(op).toHaveURL(/\/sign-in/);
    await expect(op.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
    const session = await consoleCall(op, 'GET', '/auth/session');
    expect(session.status).toBe(401);

    await signInToConsole(op);
    await expect(op.getByRole('heading', { name: 'Organisations', level: 1 })).toBeVisible();
  });

  // ---------------------------------------------------------------- Validate

  test('FT-OPC-040 a valid request validates, writes nothing, and makes Provision available', { tag: SMOKE }, async () => {
    await op.goto(`${consoleBase}/organisations/onboard`);
    await fillOnboardForm(op);
    const checked = op.waitForResponse((r) => r.url().endsWith('/op/organisations/onboard') && r.request().method() === 'POST');
    await op.getByRole('button', { name: 'Check', exact: true }).click();
    const outcome = (await (await checked).json()) as { status: string; step: string; code: string };
    expect(outcome).toMatchObject({ status: 'valid', step: 'none', code });
    await expect(op.getByRole('heading', { name: 'Review' })).toBeVisible();
    await expect(op.getByRole('button', { name: `Onboard ${displayName}`, exact: true })).toBeEnabled();

    for (const ref of [{ code }, { requestId }]) {
      const status = await organisationStatus(op, ref);
      expect(status.status, `nothing written for ${JSON.stringify(ref)}`).toBe(404);
      expect(status.body?.message).toBe('There is no such organisation or onboarding request.');
    }
  });

  test('FT-OPC-063 after an edit, Provision is unavailable until Check succeeds on the edited text', { tag: P1 }, async () => {
    await expect(op.getByRole('heading', { name: 'Review' })).toBeVisible();
    await op.getByRole('button', { name: 'Back', exact: true }).click();
    await onboardField(op, 'displayName').fill(`${displayName}x`);
    await expect(op.getByRole('button', { name: /^Onboard / })).toHaveCount(0);
    await op.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(op.getByRole('button', { name: `Onboard ${displayName}x`, exact: true })).toBeEnabled();

    await op.getByRole('button', { name: 'Back', exact: true }).click();
    await onboardField(op, 'displayName').fill(displayName);
    await expect(op.getByRole('button', { name: /^Onboard / })).toHaveCount(0);
    await op.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(op.getByRole('button', { name: `Onboard ${displayName}`, exact: true })).toBeEnabled();
  });

  // ---------------------------------------------------------------- Provision once

  test('FT-OPC-070 provisioning makes the organisation active and invites the administrator after it is active', { tag: SMOKE }, async () => {
    const sent = op.waitForRequest((r) => r.url().endsWith('/op/organisations/onboard') && r.method() === 'POST');
    await op.getByRole('button', { name: `Onboard ${displayName}`, exact: true }).click();
    provisioned = ((await sent).postDataJSON() as { input: Record<string, unknown> }).input;
    await expect(op.getByText(`${displayName} is onboarded.`)).toBeVisible();
    const result = op.locator('.kv');
    for (const [key, value] of [['Code', code], ['Request', requestId], ['Status', 'active'], ['Invitation', 'sent']]) {
      await expect(result.locator('div').filter({ has: op.locator('b', { hasText: key }) }).locator('span')).toHaveText(value!);
    }

    const status = await organisationStatus(op, { code });
    expect(status.status).toBe(200);
    const org = status.body?.['organisation'] as { status: string; legalName: string };
    const onboarding = status.body?.['onboarding'] as { step: string; invitation: string };
    expect(org).toMatchObject({ status: 'active', legalName: 'Riverbank Charitable Trust' });
    expect(onboarding).toMatchObject({ step: 'active', invitation: 'sent' });
    const history = status.body?.['history'] as { at: string; action: string; detail: { step?: string } | null }[];
    const steps = history.filter((h) => h.action === 'onboarding.step').map((h) => h.detail?.step);
    expect(steps).toEqual(expect.arrayContaining(['tenant', 'profile', 'administrator-role', 'modules', 'receipt-prefix', 'fiscal-year', 'administrator', 'readiness']));
    const activated = history.find((h) => h.action === 'organisation.activated');
    expect(activated, 'activation is in the history').toBeTruthy();
    expect(history.map((h) => h.action)).toContain('onboarding.invitation.sent');

    test.skip(!mailOk, mailBlocked);
    const { mail, link } = await invitationFor(admin.email);
    expect(mail.subject).toBe(`You have been invited to ${displayName}`);
    expect(Date.parse(mail.at), 'the invitation mail arrives only after the organisation is Active').toBeGreaterThanOrEqual(Date.parse(activated!.at));
    expect(link).toMatchObject({ org: code, kind: 'invite' });
    invite = link;
  });

  test('FT-OPC-071 the same request id and body again returns the same organisation and sends no second invitation', { tag: P0 }, async () => {
    expect(provisioned, 'the provisioned request').toBeTruthy();
    const first = await organisationStatus(op, { code });
    const again = await onboard(op, provisioned, false);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ code, requestId, status: 'active', organisationId: (first.body?.['organisation'] as { id: string }).id });
    const listed = await consoleCall(op, 'GET', `/organisations?q=${encodeURIComponent(code)}`);
    expect(((listed.body?.['organisations'] as { code: string }[]) ?? []).filter((o) => o.code === code)).toHaveLength(1);

    test.skip(!mailOk, mailBlocked);
    await op.waitForTimeout(3_000);
    expect(await mailsTo(admin.email), 'still one invitation').toHaveLength(1);
  });

  test('FT-OPC-072 the same request id with a different legal name is refused and the organisation is unchanged', { tag: P0 }, async () => {
    const changed = { ...provisioned, organisation: { ...(provisioned!['organisation'] as object), legalName: 'Riverbank Charitable Trust Changed' } };
    const answer = await onboard(op, changed, false);
    expect(answer.status).toBe(409);
    expect(answer.body?.message).toBe(`Request ${requestId} was already used for a different onboarding request.`);
    const status = await organisationStatus(op, { code });
    expect((status.body?.['organisation'] as { legalName: string }).legalName).toBe('Riverbank Charitable Trust');
  });

  test('FT-OPC-077 the administrator cannot sign in while the organisation is still provisioning', { tag: P1 }, async () => {
    test.skip(true, 'Provisioning runs to Active inside the one onboard request, so there is no provisioning window to sign in during without injecting a failure. FT-AUTH-004 covers provisioning organisations found on the installation.');
  });

  // ---------------------------------------------------------------- Set the invitation password

  test('FT-AUTH-065 the invitation opens Set your password and removes the token from the address', { tag: SMOKE }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    await app.goto(invite!.appUrl);
    await expect(app.getByRole('heading', { name: label('ui.reset.inviteTitle'), level: 1 })).toBeVisible();
    await expect(app).toHaveTitle(`${label('ui.reset.inviteTitle')} | OneNGO`);
    await expect(app).toHaveURL(`${appBase}/reset-password`);
    await app.getByLabel(label('ui.reset.newPassword')).fill(admin.password);
    await app.getByLabel(label('ui.reset.again')).fill(admin.password);
    await app.getByRole('button', { name: label('ui.reset.save'), exact: true }).click();
    await expect(app.getByText(label('ui.reset.done'))).toBeVisible();
    await expect(app.getByRole('link', { name: label('ui.reset.goToSignIn') })).toHaveAttribute('href', `/o/${code}/sign-in`);
    expect((await apiSignIn(admin)).status, 'after save, sign-in works').toBe(200);
  });

  test('FT-AUTH-066 the same invitation opened again is refused as used', { tag: P0 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    await app.goto(invite!.appUrl);
    await app.getByLabel(label('ui.reset.newPassword')).fill('quiet lake path nineteen');
    await app.getByLabel(label('ui.reset.again')).fill('quiet lake path nineteen');
    await app.getByRole('button', { name: label('ui.reset.save'), exact: true }).click();
    await expect(app.getByRole('alert')).toHaveText('This link has expired or has already been used. Ask for a new one.');
    expect((await apiSignIn(admin)).status, 'the password set from the invitation still works').toBe(200);
  });

  // ---------------------------------------------------------------- Finish setup and invite Finance

  test('FT-NAV-001 Asha opens Home, Records, Inbox, Settings, Administration, and Builder, each with its heading', { tag: P0 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    await signInMember(app, admin);
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
    for (const [destination, heading] of [
      [label('ui.nav.records'), label('ui.nav.records')],
      [label('ui.nav.inbox'), label('ui.nav.inbox')],
      [label('ui.nav.settings'), label('ui.nav.settings')],
      [label('ui.crumbs.administration'), label('ui.crumbs.administration')],
      [label('ui.builder.title'), label('ui.builder.title')],
      [label('ui.nav.home'), null],
    ] as const) {
      await openDestination(app, destination);
      if (heading) await expect(app.getByRole('heading', { name: heading, level: 1, exact: true })).toBeVisible();
      else await expect(app.getByText(label('ui.home.welcome', { name: admin.name }))).toBeVisible();
      expect(new URL(app.url()).pathname, `${destination} is not a More screen`).not.toMatch(/^\/more/);
    }
  });

  test('FT-NAV-008 the app bar shows the product, the organisation, the Inbox bell, and the initials, not the page name', { tag: P1 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    await app.goto('/records');
    const bar = app.locator('.app-bar');
    await expect(bar).toContainText('OneNGO');
    await expect(bar).toContainText(displayName);
    await expect(bar.getByRole('link', { name: new RegExp(`^${label('ui.nav.inbox')}`) })).toBeVisible();
    await expect(bar.getByRole('img', { name: label('ui.nav.account') })).toHaveText('AM');
    await expect(bar).not.toContainText(label('ui.nav.records'));
    test.info().annotations.push({ type: 'note', description: 'The new organisation has no logo yet, so the logo half of the bar is not checked.' });
  });

  test('FT-ADM-001 Asha sees the checklist and every group; a people administrator sees People and Roles only', { tag: P0 }, async ({ browser }) => {
    test.skip(!mailOk || !invite, mailBlocked);
    await app.goto('/admin');
    await expect(app.getByRole('heading', { name: label('ui.admin.organisation.setupTitle') })).toBeVisible();
    for (const group of ['ui.admin.organisation', 'ui.admin.people', 'ui.admin.integrations', 'ui.admin.activity']) {
      await expect(app.getByRole('heading', { name: label(group), exact: true })).toBeVisible();
    }

    const other = await browser.newContext({ baseURL: appBase });
    try {
      const page = await other.newPage();
      await signIn(page, accounts.peopleAdmin.email, accounts.peopleAdmin.name);
      await page.goto('/admin');
      await expect(page.getByRole('link', { name: label('ui.crumbs.people') }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: label('ui.crumbs.admin.roles') }).first()).toBeVisible();
      await expect(page.getByRole('heading', { name: label('ui.admin.organisation.setupTitle') })).toHaveCount(0);
      for (const group of ['ui.admin.organisation', 'ui.admin.integrations', 'ui.admin.activity']) {
        await expect(page.getByRole('heading', { name: label(group), exact: true })).toHaveCount(0);
      }
    } finally {
      await other.close();
    }
  });

  test('FT-ADM-002 a new organisation shows the required progress, the optional count, and what is still required', { tag: P0 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    await app.goto('/admin');
    const progress = label('ui.admin.organisation.setupProgress', { done: 2, total: 5 });
    await expect(app.locator('#org-setup-status')).toHaveText(new RegExp(`^${progress} · \\d+ optional open$`));
    const detail = app.locator('.org__strip .org__note').last();
    for (const key of ['identity', 'receiptSeries', 'operationalRole'] as const) {
      await expect(detail).toContainText(label(`ui.admin.organisation.setup.${key}`));
    }
    await expect(detail).toContainText('are still required.');
    await expect(app.getByText(label('ui.admin.organisation.setupDone'))).toHaveCount(0);
  });

  test('FT-ADM-003 the checklist lists each step with a link to its screen, and Escape returns focus', { tag: P1 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    const dialog = await openChecklist();
    const rows = dialog.locator('.admin__row');
    await expect(rows).toHaveCount(SETUP_KEYS.length);
    for (const [i, key] of SETUP_KEYS.entries()) {
      await expect(rows.nth(i)).toContainText(label(`ui.admin.organisation.setup.${key}`));
      await expect(rows.nth(i).getByRole('link')).toHaveAttribute('href', SETUP_LINKS[key]);
    }
    await app.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(app.getByRole('button', { name: label('ui.admin.organisation.setupView'), exact: true })).toBeFocused();
  });

  test('FT-ADM-004 Confirm the identity marks Identity Done', { tag: P0 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    const dialog = await openChecklist();
    const row = setupRow(dialog, 'identity');
    await row.getByRole('button', { name: label('ui.admin.organisation.confirmIdentity'), exact: true }).click();
    await expect(row.locator('.org__sr')).toHaveText(label('ui.admin.organisation.stateDone'));
  });

  test('FT-ADM-005 identity with the contact email missing cannot be confirmed', { tag: P1 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    await app.goto('/admin/organisation/profile');
    const email = app.getByLabel(label('ui.admin.organisation.email'));
    const original = await email.inputValue();
    await email.fill('');
    await app.getByRole('button', { name: label('ui.common.save'), exact: true }).click();
    const saved = await appears(app.getByText(label('ui.admin.organisation.saved')));
    test.skip(!saved, 'Onboarding requires legal name, address, and contact email, and Profile did not save an empty contact email, so there is no identity with a field missing to confirm.');
    try {
      const dialog = await openChecklist();
      const row = setupRow(dialog, 'identity');
      await expect(row.locator('.org__sr')).toHaveText(label('ui.admin.organisation.stateRequired'));
      await row.getByRole('button', { name: label('ui.admin.organisation.confirmIdentity'), exact: true }).click();
      await expect(row.locator('.org__sr')).toHaveText(label('ui.admin.organisation.stateRequired'));
    } finally {
      await app.goto('/admin/organisation/profile');
      await app.getByLabel(label('ui.admin.organisation.email')).fill(original);
      await app.getByRole('button', { name: label('ui.common.save'), exact: true }).click();
      await expect(app.getByText(label('ui.admin.organisation.saved'))).toBeVisible();
    }
  });

  test('FT-ADM-006 I have reviewed the receipt series marks Receipt series Done', { tag: P1 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    const dialog = await openChecklist();
    const row = setupRow(dialog, 'receiptSeries');
    await row.getByRole('button', { name: label('ui.admin.organisation.confirmReceipts'), exact: true }).click();
    await expect(row.locator('.org__sr')).toHaveText(label('ui.admin.organisation.stateDone'));
  });

  const addPerson = async (person: { email: string; name: string }, role: string) => {
    await app.goto('/admin/people');
    await app.getByRole('button', { name: label('ui.crumbs.addPerson'), exact: true }).click();
    const add = app.getByRole('dialog', { name: label('ui.crumbs.addPerson') });
    await expect(add.getByText(label('ui.people.inviteHint'))).toBeVisible();
    await add.getByLabel(label('ui.people.col.email')).fill(person.email);
    await add.getByLabel(label('ui.people.col.name')).fill(person.name);
    await add.getByRole('combobox').fill(role);
    await app.getByRole('option', { name: role, exact: true }).click();
    await expect(add.getByRole('checkbox')).toBeChecked();
    await add.getByRole('button', { name: label('ui.people.addAndInvite'), exact: true }).click();
    await expect(app.getByText(label('ui.people.addedInvited', { name: person.name }))).toBeVisible();
    await app.getByRole('searchbox', { name: label('ui.records.searchList') }).fill(person.name);
    await expect(app.getByText(label('ui.people.status.invited')).first()).toBeVisible();
  };

  test('FT-ADM-020 Finance and Viewer are added as Invited, and each gets one mail with one link', { tag: P0 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    await addPerson(finance, 'Finance');
    await addPerson(viewer, 'Viewer');
    for (const person of [finance, viewer]) {
      await expect.poll(async () => (await mailsTo(person.email)).length, { message: `invitation to ${person.email}`, timeout: 30_000 }).toBe(1);
      const [mail] = await mailsTo(person.email);
      expect(passwordLinks(await mailText(mail!.id)), `one link for ${person.email}`).toHaveLength(1);
    }
  });

  test('FT-ADM-021 adding with no email or name shows field errors, and a person needs a role', { tag: P1 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    await app.goto('/admin/people');
    await app.getByRole('button', { name: label('ui.crumbs.addPerson'), exact: true }).click();
    const add = app.getByRole('dialog', { name: label('ui.crumbs.addPerson') });
    await add.getByRole('button', { name: label('ui.people.addAndInvite'), exact: true }).click();
    await expect(add.getByText(label('ui.records.required', { field: label('ui.people.col.email') }))).toBeVisible();
    await expect(add.getByText(label('ui.records.required', { field: label('ui.people.col.name') }))).toBeVisible();

    const nobody = `No role ${run}`;
    await add.getByLabel(label('ui.people.col.email')).fill(`norole${run}@riverbank.example`);
    await add.getByLabel(label('ui.people.col.name')).fill(nobody);
    await add.getByRole('button', { name: label('ui.people.addAndInvite'), exact: true }).click();
    const added = app.getByText(label('ui.people.addedInvited', { name: nobody }));
    if (await appears(added)) knownDefect('DEF-24', 'A person can be added and invited with no role.');
    await expect(added).toHaveCount(0);
    await expect(add).toBeVisible();
  });

  test('FT-ADM-007 a member in Finance marks People in roles Done, setup is complete, and who completed it is recorded', { tag: P0 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    const dialog = await openChecklist();
    await expect(setupRow(dialog, 'operationalRole').locator('.org__sr')).toHaveText(label('ui.admin.organisation.stateDone'));
    await expect(dialog.getByText(label('ui.admin.organisation.setupDone'))).toBeVisible();

    const signedIn = await apiSignIn(admin);
    const api = await bearerApi(signedIn.accessToken!);
    try {
      const setup = (await (await api.get('/api/admin/organisation/setup')).json()) as { complete: boolean; completedAt: string | null };
      expect(setup.complete).toBe(true);
      expect(setup.completedAt, 'the completion is recorded').toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  test('FT-E2E-01 the new NGO has finished setup and the audit shows each step', { tag: P0 }, async () => {
    test.skip(!mailOk || !invite, mailBlocked);
    await app.goto('/admin');
    await expect(app.locator('.org__strip').getByText(label('ui.admin.organisation.setupDone'))).toBeVisible();

    const signedIn = await apiSignIn(admin);
    const api = await bearerApi(signedIn.accessToken!);
    try {
      const audit = (await (await api.get('/api/admin/audit?limit=200')).json()) as { items: { action: string }[] };
      const actions = audit.items.map((entry) => entry.action);
      for (const action of ['organisation.activated', 'member.invited', 'password.set', 'organisation.setup.confirmed', 'organisation.setup.completed']) {
        expect(actions, `audit has ${action}`).toContain(action);
      }
      expect(actions.filter((a) => a === 'organisation.setup.confirmed').length, 'identity and receipt series confirmations').toBeGreaterThanOrEqual(2);
    } finally {
      await api.dispose();
    }

    await app.goto('/admin/roles');
    for (const role of ['Organisation administrator', 'Finance', 'Viewer']) {
      await expect(app.getByText(role, { exact: true }).first()).toBeVisible();
    }
    const status = await organisationStatus(op, { code });
    expect((status.body?.['organisation'] as { status: string }).status).toBe('active');
    expect((status.body?.['onboarding'] as { requestId: string }).requestId).toBe(requestId);
  });
});

/**
 * The Riverbank request typed into the console's Onboard form. Each input sits inside its label, so a filled
 * value joins the label text; the inputs are found by their form names, which the screen sets one to one.
 */
async function fillOnboardForm(op: Page): Promise<void> {
  const fields: [string, string][] = [
    ['requestId', requestId],
    ['code', code],
    ['displayName', displayName],
    ['legalName', 'Riverbank Charitable Trust'],
    ['email', 'office@riverbank.example'],
    ['phone', '+91 80 4000 1200'],
    ['line1', '12 Lake Road'],
    ['city', 'Bengaluru'],
    ['state', 'Karnataka'],
    ['postalCode', '560001'],
    ['country', 'IN'],
    ['timezone', 'Asia/Kolkata'],
    ['region', 'asia-south1'],
    ['adminName', admin.name],
    ['adminEmail', admin.email],
    ['modules', 'donations'],
    ['startMonth', '4'],
    ['fiscalYear', currentFiscalYear(4)],
    ['receiptPrefix', 'RCPT'],
  ];
  for (const [name, value] of fields) await onboardField(op, name).fill(value);
  await op.locator('select[name="language"]').selectOption('en');
  await op.getByRole('button', { name: 'Add a registration', exact: true }).click();
  await onboardField(op, 'type0').fill(registration.type);
  await onboardField(op, 'number0').fill(registration.number);
}

function onboardField(op: Page, name: string) {
  return op.locator(`form input[name="${name}"]`);
}
