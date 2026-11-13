import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { runTag } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import {
  apiSignIn,
  bearerApi,
  consoleBase,
  disposableOrganisation,
  guard,
  journeyContext,
  lifecycleCall,
  lifecycleInConsole,
  lookup,
  openStatus,
  organisationStatus,
  signInToConsole,
  skipWithoutConsole,
  statusBadge,
  type Member,
} from '../../../src/journeys/operator.js';

/**
 * FT-E2E-11: the full operator closes a disposable organisation that is already suspended. Closed stays closed.
 * Set E2E_CLOSURE_ORG (and E2E_CLOSURE_EMAIL, E2E_CLOSURE_PASSWORD) to close a prepared one, or a fresh one is
 * provisioned and suspended first. FT-OPC-088 runs only when E2E_FAILED_ORG names an organisation whose provisioning failed.
 */
const run = runTag('e2e11').split('-')[1]!;
const failedOrg = process.env.E2E_FAILED_ORG;
const SMOKE = ['@e2e', '@FT-E2E-11', '@P0', '@smoke'];
const P0 = ['@e2e', '@FT-E2E-11', '@P0'];
const P1 = ['@e2e', '@FT-E2E-11', '@P1'];

test.describe.serial('FT-E2E-11 Closure', () => {
  test.skip(!consoleBase, skipWithoutConsole);
  test.describe.configure({ timeout: 150_000 });

  let context: BrowserContext;
  let op: Page;
  let code = '';
  let displayName = '';
  let member: Member | null = null;
  const reason = `Closure at the organisation's request ${run}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    if (!consoleBase) return;
    context = await journeyContext(browser);
    op = await context.newPage();
    await signInToConsole(op);
    const disposable = await disposableOrganisation(op, 'E2E_CLOSURE', `cls${run}`);
    if (!disposable) return;
    code = disposable.code;
    member = disposable.member;

    if (member) {
      const signedIn = await apiSignIn(member);
      if (signedIn.status === 200) {
        const api = await bearerApi(signedIn.accessToken!);
        try {
          await api.post('/api/records/donor', { data: { name: `Closure donor ${run}` } });
        } finally {
          await api.dispose();
        }
      }
    }
    const status = await organisationStatus(op, { code });
    const org = status.body?.['organisation'] as { status: string; displayName: string };
    displayName = org.displayName;
    if (org.status === 'active') {
      const suspended = await lifecycleCall(op, 'suspend', code, `Suspended before closure ${run}`);
      expect(suspended.status, suspended.text).toBe(200);
    }
  });

  test.afterAll(async () => {
    await context?.close();
  });

  const needOrg = () => test.skip(!code, 'No disposable organisation: provisioning failed and E2E_CLOSURE_ORG is not set.');

  test('FT-OPC-087 a suspended organisation is closed: sign-in refused, no Reactivate, still found', { tag: SMOKE }, async () => {
    needOrg();
    await openStatus(op, code);
    await expect(statusBadge(op)).toHaveText('Suspended');
    await lifecycleInConsole(op, code, 'close', reason);
    await expect(statusBadge(op)).toHaveText('Closed');
    await expect(op.getByText('This organisation is closed. Members cannot sign in, and it cannot be reopened from the console.')).toBeVisible();
    await expect(op.getByRole('button', { name: 'Reactivate', exact: true })).toHaveCount(0);

    const reactivate = await lifecycleCall(op, 'reactivate', code, '');
    expect(reactivate.status).toBeGreaterThanOrEqual(400);
    expect(reactivate.body?.message).toBe('Only a suspended organisation can be reactivated. This one is closed.');

    if (member) expect((await apiSignIn(member)).status, 'member sign-in').not.toBe(200);
    const page = await context.newPage();
    try {
      await page.goto(`/o/${code}/sign-in`);
      await expect(page.getByRole('heading', { name: label('ui.auth.orgNotFound') })).toBeVisible();
    } finally {
      await page.close();
    }

    await op.goto(`${consoleBase}/organisations`);
    await op.locator('input[name="ref"]').fill(code);
    await op.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(op.getByRole('heading', { name: displayName, level: 1 })).toBeVisible();
    await expect(statusBadge(op)).toHaveText('Closed');
    test.info().annotations.push({
      type: 'not checked',
      description: 'Records remaining in the database cannot be read through the app once the organisation is closed; check the closure donor in the database by hand.',
    });
  });

  test('FT-OPC-088 an organisation whose provisioning failed can be closed', { tag: P1 }, async () => {
    test.skip(!failedOrg, 'Needs E2E_FAILED_ORG: an organisation in Provisioning failed. Provisioning cannot be made to fail from the console without fault injection.');
    guard(failedOrg!);
    await openStatus(op, failedOrg!);
    await expect(statusBadge(op)).toHaveText('Failed');
    await lifecycleInConsole(op, failedOrg!, 'close', `Closing a failed onboarding ${run}`);
    await expect(statusBadge(op)).toHaveText('Closed');
  });

  test('FT-OPC-089 a closed organisation cannot be reactivated or suspended', { tag: P1 }, async () => {
    needOrg();
    const reactivate = await lifecycleCall(op, 'reactivate', code, '');
    expect(reactivate.status).toBeGreaterThanOrEqual(400);
    expect(reactivate.body?.message).toBe('Only a suspended organisation can be reactivated. This one is closed.');
    const suspend = await lifecycleCall(op, 'suspend', code, `Suspending a closed organisation ${run}`);
    expect(suspend.status).toBeGreaterThanOrEqual(400);
    expect(suspend.body?.message).toBe('Only an active organisation can be suspended. This one is closed.');
    await openStatus(op, code);
    for (const action of ['Suspend', 'Reactivate', 'Close']) {
      await expect(op.getByRole('button', { name: action, exact: true })).toHaveCount(0);
    }
  });

  test('FT-E2E-11 the closed organisation refuses sign-in for good and keeps its history', { tag: P0 }, async () => {
    needOrg();
    const status = await organisationStatus(op, { code });
    expect((status.body?.['organisation'] as { status: string }).status).toBe('closed');
    const history = status.body?.['history'] as { action: string; detail: { reason?: string } | null }[];
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(['organisation.suspended', 'organisation.closed']));
    expect(history.find((h) => h.action === 'organisation.closed')?.detail?.reason).toBe(reason);

    const unknown = await lookup(`no-such-${run}`);
    const closed = await lookup(code);
    expect(closed.status).toBe(404);
    expect(closed.message).toBe(unknown.message);
    if (member) expect((await apiSignIn(member)).status, 'member sign-in').not.toBe(200);
  });
});
