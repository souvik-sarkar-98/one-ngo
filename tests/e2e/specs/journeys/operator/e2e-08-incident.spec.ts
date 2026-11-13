import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { runTag } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import { openDestination } from '../../../src/shell.js';
import {
  apiSignIn,
  bearerApi,
  consoleBase,
  consoleCall,
  createApiKey,
  disposableOrganisation,
  journeyContext,
  keyQuery,
  lifecycleCall,
  lifecycleInConsole,
  lookup,
  openStatus,
  organisationStatus,
  refreshWith,
  signInMember,
  signInToConsole,
  skipWithoutConsole,
  statusBadge,
  type Member,
} from '../../../src/journeys/operator.js';

/**
 * FT-E2E-08: the full operator suspends a disposable organisation, members, keys and refresh tokens are refused
 * and the public lookup is uniform, then the operator reactivates it and members sign in again with a new key.
 * Set E2E_DISPOSABLE_ORG (and E2E_DISPOSABLE_EMAIL, E2E_DISPOSABLE_PASSWORD) to reuse one, or a fresh one is provisioned.
 */
const run = runTag('e2e08').split('-')[1]!;
const SMOKE = ['@e2e', '@FT-E2E-08', '@P0', '@smoke'];
const P0 = ['@e2e', '@FT-E2E-08', '@P0'];
const P1 = ['@e2e', '@FT-E2E-08', '@P1'];
const P2 = ['@e2e', '@FT-E2E-08', '@P2'];
const noMember = 'No member of the disposable organisation can sign in: set E2E_DISPOSABLE_EMAIL, or make the fixture mail log reachable so the invitation can be accepted.';

/**
 * The reason boundary changes nothing: each call is aimed at a code no organisation has, so the reason rule runs,
 * then the missing organisation stops the call. Its result does not skip the stateful incident below.
 */
test.describe('FT-E2E-08 Incident: refusals that change nothing', () => {
  test.skip(!consoleBase, skipWithoutConsole);
  test.describe.configure({ timeout: 120_000 });

  test('FT-OPC-083 a reason of 500 characters is accepted trimmed; 501 and blank are refused', { tag: P1 }, async ({ browser }) => {
    const context = await journeyContext(browser);
    try {
      const op = await context.newPage();
      await signInToConsole(op);
      const nowhere = `no-such-${run}`;
      const tooLong = await lifecycleCall(op, 'suspend', nowhere, 'r'.repeat(501));
      expect(tooLong.body?.message).toBe('The reason is at most 500 characters.');
      for (const blank of ['     ', '']) {
        const answer = await lifecycleCall(op, 'suspend', nowhere, blank);
        expect(answer.status, `reason ${JSON.stringify(blank)} is refused`).toBeGreaterThanOrEqual(400);
        expect(answer.body?.message, `reason ${JSON.stringify(blank)}`).toBe('Give the reason, which is kept in the audit.');
      }
      // A 500-character reason, trimmed, gets past the reason rule to the missing organisation.
      const fits = await lifecycleCall(op, 'suspend', nowhere, `  ${'r'.repeat(500)}  `);
      expect(fits.body?.message).toBe('There is no such organisation.');
    } finally {
      await context.close();
    }
  });
});

test.describe.serial('FT-E2E-08 Incident (suspend and restore)', () => {
  test.skip(!consoleBase, skipWithoutConsole);
  test.describe.configure({ timeout: 180_000 });

  let context: BrowserContext;
  let op: Page;
  let app: Page;
  let code = '';
  let member: Member | null = null;
  const donorName = `Incident donor ${run}`;
  let oldAccess: string | undefined;
  let oldRefresh: string | undefined;
  let oldKey: string | undefined;
  const reasonTyped = `Incident drill ${run}: suspend while the leak is checked`;
  let reasonOnReturn: string | undefined;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    if (!consoleBase) return;
    context = await journeyContext(browser);
    op = await context.newPage();
    app = await context.newPage();
    await signInToConsole(op);
    const disposable = await disposableOrganisation(op, 'E2E_DISPOSABLE', `inc${run}`);
    if (!disposable) return;
    code = disposable.code;
    member = disposable.member;
    if (!member) return;

    // What the incident must end: a signed-in tab, an access and refresh token, and an API key.
    const signedIn = await apiSignIn(member);
    expect(signedIn.status, 'the member signs in before the incident').toBe(200);
    oldAccess = signedIn.accessToken;
    oldRefresh = signedIn.refreshToken;
    const adminApi = await bearerApi(oldAccess!);
    try {
      oldKey = await createApiKey(adminApi, `incident-${run}`);
      const donor = await adminApi.post('/api/records/donor', { data: { name: donorName } });
      expect(donor.status(), 'a donor exists before the incident').toBeLessThan(300);
    } finally {
      await adminApi.dispose();
    }
    expect(await keyQuery(oldKey!), 'the key works before the incident').toBe(200);
    await signInMember(app, member);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  const needOrg = () => test.skip(!code, 'No disposable organisation: provisioning failed and E2E_DISPOSABLE_ORG is not set.');
  const needMember = () => {
    needOrg();
    test.skip(!member, noMember);
  };

  // ---------------------------------------------------------------- Suspend

  test('FT-OPC-080 an active organisation is suspended after a fresh check, with the reason in its history', { tag: SMOKE }, async () => {
    needOrg();
    await openStatus(op, code);
    await expect(statusBadge(op)).toHaveText('Active');
    ({ reasonOnReturn } = await lifecycleInConsole(op, code, 'suspend', reasonTyped));
    await expect(statusBadge(op)).toHaveText('Suspended');
    const history = op.locator('section.card').filter({ has: op.getByRole('heading', { name: 'History' }) });
    await expect(history.getByText('organisation.suspended').first()).toBeVisible();
    await expect(history.getByText(reasonTyped)).toBeVisible();
  });

  test('FT-OPC-084 back from the step-up, the reason field is empty and the reason is typed after the check', { tag: P2 }, async () => {
    needOrg();
    expect(reasonOnReturn, 'the reason field as it stood on return from the check in FT-OPC-080').toBe('');
    const status = await organisationStatus(op, { code });
    const history = status.body?.['history'] as { action: string; detail: { reason?: string } | null }[];
    expect(history.find((h) => h.action === 'organisation.suspended')?.detail?.reason).toBe(reasonTyped);
  });

  test('FT-OPC-081 after suspend, sign-in, the API key, the refresh token, and the open tab are all refused', { tag: P0 }, async () => {
    needMember();
    expect((await apiSignIn(member!)).status, 'password sign-in').not.toBe(200);
    expect(await keyQuery(oldKey!), 'API key').toBeGreaterThanOrEqual(400);
    expect(await refreshWith(oldRefresh!), 'refresh token').toBeGreaterThanOrEqual(400);

    await openDestination(app, label('ui.nav.records'));
    await expect(app).toHaveURL(/\/sign-in/);

    const page = await context.newPage();
    try {
      await page.goto(`/o/${code}/sign-in`);
      await expect(page.getByRole('heading', { name: label('ui.auth.orgNotFound') })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('FT-OPC-082 after suspend, the sign-in lookup gives the uniform not-available answer', { tag: P0 }, async () => {
    needOrg();
    const unknown = await lookup(`no-such-${run}`);
    const suspended = await lookup(code);
    expect(suspended.status).toBe(404);
    expect(suspended.message).toBe(unknown.message);
    test.info().annotations.push({
      type: 'not checked',
      description: 'The disposable organisation has no paid donation, so there is no public receipt link to record. Check it by hand on an organisation that has one.',
    });
  });

  test('FT-AUTH-004 unknown, provisioning, failed, suspended, and closed organisations all look the same at sign-in', { tag: SMOKE }, async () => {
    needOrg();
    const codes: Record<string, string> = { unknown: `no-such-${run}`, suspended: code };
    for (const status of ['provisioning', 'provisioning_failed', 'closed']) {
      const listed = await consoleCall(op, 'GET', `/organisations?status=${status}`);
      const found = ((listed.body?.['organisations'] as { code: string; status: string }[]) ?? []).find((o) => o.status === status);
      if (found) codes[status] = found.code;
      else test.info().annotations.push({ type: 'not checked', description: `No ${status} organisation exists on this installation.` });
    }

    const page = await context.newPage();
    try {
      const unknown = await lookup(codes['unknown']!);
      for (const [state, value] of Object.entries(codes)) {
        await page.goto(`/o/${value}/sign-in`);
        await expect(page.getByRole('heading', { name: label('ui.auth.orgNotFound') }), state).toBeVisible();
        await expect(page, state).toHaveTitle(`${label('ui.auth.signIn')} | OneNGO`);
        const answer = await lookup(value);
        expect(answer.status, state).toBe(404);
        expect(answer.message, state).toBe(unknown.message);
        expect(answer.ms, `${state} answers in at least 150 ms`).toBeGreaterThanOrEqual(150);
      }
    } finally {
      await page.close();
    }
  });

  // ---------------------------------------------------------------- Restore

  test('FT-OPC-085 reactivating with a step-up and no reason keeps old sessions and keys ended; new ones work', { tag: P0 }, async () => {
    needOrg();
    await lifecycleInConsole(op, code, 'reactivate', '');
    await expect(statusBadge(op)).toHaveText('Active');

    test.skip(!member, noMember);
    const oldApi = await bearerApi(oldAccess!);
    try {
      expect((await oldApi.post('/api/records/donor/query', { data: {} })).status(), 'old access token').toBeGreaterThanOrEqual(400);
    } finally {
      await oldApi.dispose();
    }
    expect(await refreshWith(oldRefresh!), 'old refresh token').toBeGreaterThanOrEqual(400);
    expect(await keyQuery(oldKey!), 'old API key').toBeGreaterThanOrEqual(400);

    const fresh = await apiSignIn(member!);
    expect(fresh.status, 'a fresh sign-in').toBe(200);
    const api = await bearerApi(fresh.accessToken!);
    try {
      const newKey = await createApiKey(api, `incident-new-${run}`);
      expect(await keyQuery(newKey), 'a new key').toBe(200);
    } finally {
      await api.dispose();
    }
    await signInMember(app, member!);
  });

  test('FT-OPC-086 suspend, reactivate, and close are refused from the wrong state', { tag: P1 }, async () => {
    needOrg();
    await openStatus(op, code);
    await expect(statusBadge(op)).toHaveText('Active');
    await expect(op.getByRole('button', { name: 'Reactivate', exact: true })).toHaveCount(0);
    await expect(op.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);

    const reactivate = await lifecycleCall(op, 'reactivate', code, '');
    expect(reactivate.body?.message).toBe('Only a suspended organisation can be reactivated. This one is active.');
    const close = await lifecycleCall(op, 'close', code, `Closing an active organisation ${run}`);
    expect(close.body?.message).toBe('Suspend the organisation before closing it. This one is active.');

    const suspend = await lifecycleCall(op, 'suspend', code, `Second suspension ${run}`);
    expect(suspend.status, suspend.text).toBe(200);
    const again = await lifecycleCall(op, 'suspend', code, `Suspending twice ${run}`);
    expect(again.body?.message).toBe('Only an active organisation can be suspended. This one is suspended.');
    await openStatus(op, code);
    await expect(op.getByRole('button', { name: 'Suspend', exact: true })).toHaveCount(0);

    const restored = await lifecycleCall(op, 'reactivate', code, '');
    expect(restored.status, restored.text).toBe(200);
  });

  test('FT-E2E-08 after the incident the organisation is active, members sign in, and nothing was lost', { tag: P0 }, async () => {
    needOrg();
    const status = await organisationStatus(op, { code });
    expect((status.body?.['organisation'] as { status: string }).status).toBe('active');
    const actions = (status.body?.['history'] as { action: string }[]).map((h) => h.action);
    expect(actions).toEqual(expect.arrayContaining(['organisation.suspended', 'organisation.reactivated']));

    test.skip(!member, noMember);
    expect(await keyQuery(oldKey!), 'the key from before the incident stays dead').toBeGreaterThanOrEqual(400);
    expect(await refreshWith(oldRefresh!), 'the session from before the incident stays dead').toBeGreaterThanOrEqual(400);
    const fresh = await apiSignIn(member!);
    expect(fresh.status).toBe(200);
    const api: APIRequestContext = await bearerApi(fresh.accessToken!);
    try {
      const found = await api.post('/api/records/donor/query', { data: { search: donorName } });
      expect(found.status()).toBe(200);
      expect(await found.text(), 'the donor from before the incident is still there').toContain(donorName);
    } finally {
      await api.dispose();
    }
    await signInMember(app, member!);
  });
});
