import { createHmac, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { keyApi, memberApi, runTag } from '../../../src/api.js';
import { label } from '../../../src/catalogue.js';
import { signIn } from '../../../src/sign-in.js';
import { auditSince, fixtureTlsDir, hasFixtureTls, startWebhookReceiver, type WebhookReceiver } from '../../../src/journeys/integration.js';

const invalidKey = 'This API key is not valid.';
const reusedKey = 'This Idempotency-Key was already used for a different request. Use a new key.';
const connectorKey = 'e2eReceiver';
const receiverEnv =
  'The receiver serves the integration fixture certificate: set E2E_FIXTURE_TLS_DIR to the fixture tls folder whose ca.crt the API trusts through NODE_EXTRA_CA_CERTS, and run the API with 127.0.0.1 in CONNECTOR_ALLOWED_HOSTS (npm run dev does both).';

interface CreatedKey {
  id: string;
  name: string;
  role: string | null;
  token: string;
}

interface KeyView {
  id: string;
  name: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

test.describe.serial('FT-E2E-10 Integration', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  const started = new Date();
  const viewerKeyName = runTag('ledger-reader');
  const financeKeyName = runTag('ledger-writer');
  const idempotencyKey = runTag('e2e10');
  const donorName = runTag('E2E API donor');
  const signingSecret = randomBytes(24).toString('hex');
  let admin: APIRequestContext;
  let viewerKey: CreatedKey | undefined;
  let financeKey: CreatedKey | undefined;
  let createdId = '';
  let receiver: WebhookReceiver | undefined;
  let delivered = false;

  test.beforeAll(async () => {
    admin = await memberApi(accounts.admin.email);
  });

  test.afterAll(async () => {
    if (financeKey) await admin.delete(`/api/admin/api-keys/${financeKey.id}`);
    if (viewerKey && !(await keyView(admin, viewerKey.id))?.revokedAt) await admin.delete(`/api/admin/api-keys/${viewerKey.id}`);
    if (receiver) {
      await admin.put(`/api/admin/connectors/${connectorKey}`, { data: { enabled: false } });
      await receiver.close();
    }
    await admin?.dispose();
  });

  test('FT-ADM-080 a new Viewer key shows its secret once, copies it, and forgets it', { tag: ['@e2e', '@FT-E2E-10', '@P0', '@smoke'] }, async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, accounts.admin.email, accounts.admin.name);
    await page.goto('/admin/api-keys');
    await page.getByRole('button', { name: label('ui.crumbs.newApiKey'), exact: true }).first().click();
    const form = page.getByRole('dialog', { name: label('ui.crumbs.newApiKey') });
    await form.getByLabel(label('ui.admin.keys.col.name'), { exact: true }).fill(viewerKeyName);
    await form.getByRole('combobox', { name: label('ui.admin.keys.role') }).click();
    await page.getByRole('option', { name: 'Viewer', exact: true }).click();
    const answer = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/admin/api-keys');
    await form.getByRole('button', { name: label('ui.admin.keys.create'), exact: true }).click();
    const res = await answer;
    expect(res.status()).toBe(201);
    viewerKey = (await res.json()) as CreatedKey;
    expect(viewerKey.role).toBe('viewer');
    expect(viewerKey.token.startsWith(`${viewerKey.id}.`)).toBe(true);

    const shown = page.getByRole('dialog', { name: label('ui.admin.keys.created') });
    await expect(shown.getByText(label('ui.admin.keys.copyNow'))).toBeVisible();
    await expect(shown.getByText(label('ui.admin.keys.actsAs', { role: 'Viewer' }), { exact: false })).toBeVisible();
    await expect(shown.getByText(viewerKey.token, { exact: true })).toBeVisible();
    await shown.getByRole('button', { name: label('ui.admin.keys.copy'), exact: true }).click();
    await expect(shown.getByRole('button', { name: label('ui.admin.keys.copied'), exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(viewerKey.token);

    await shown.getByRole('button', { name: label('ui.admin.keys.done'), exact: true }).click();
    await expect(shown).toHaveCount(0);
    await expect(page.getByText(viewerKey.token)).toHaveCount(0);
    await expect(keyRow(page, viewerKeyName)).toBeVisible();
    await page.reload();
    await expect(keyRow(page, viewerKeyName)).toBeVisible();
    await expect(page.getByText(viewerKey.token)).toHaveCount(0);
  });

  test('FT-ADM-081 the Viewer key reads donors with PAN masked, cannot write, and records its last use', { tag: ['@e2e', '@FT-E2E-10', '@P0'] }, async () => {
    test.skip(!viewerKey, 'FT-ADM-080 did not create the key.');
    const external = await asKey(viewerKey!);
    try {
      const res = await external.post('/api/records/donor/query', { data: {} });
      expect(res.status()).toBe(200);
      const { items } = (await res.json()) as { items: { data: Record<string, unknown> }[] };
      const ravi = items.find((d) => d.data.name === 'Ravi Kumar');
      expect(ravi, 'seeded donor Ravi Kumar').toBeTruthy();
      expect(ravi!.data.pan).toBe('***');
      for (const d of items) expect(d.data.pan === undefined || d.data.pan === '***').toBe(true);
      expect(JSON.stringify(items)).not.toContain('ABCDE1234F');

      const write = await external.post('/api/records/donor', { data: { name: runTag('Viewer key donor') } });
      expect(write.status()).toBe(403);
    } finally {
      await external.dispose();
    }
    expect((await keyView(admin, viewerKey!.id))?.lastUsedAt).not.toBeNull();
  });

  test('FT-REC-049 the same Idempotency-Key and body replays the first answer; a different body is refused', { tag: ['@e2e', '@FT-E2E-10', '@P1'] }, async () => {
    const res = await admin.post('/api/admin/api-keys', { data: { name: financeKeyName, role: 'finance' } });
    expect(res.status()).toBe(201);
    financeKey = (await res.json()) as CreatedKey;
    const external = await asKey(financeKey);
    try {
      const body = { donorName, amount: 501 };
      const headers = { 'idempotency-key': idempotencyKey };
      const first = await external.post('/api/records/donation', { data: body, headers });
      expect(first.status()).toBe(201);
      expect(first.headers()['idempotent-replayed']).toBeUndefined();
      const firstBody = (await first.json()) as { record: { id: string } };
      createdId = firstBody.record.id;

      const again = await external.post('/api/records/donation', { data: body, headers });
      expect(again.status()).toBe(201);
      expect(again.headers()['idempotent-replayed']).toBe('true');
      expect(await again.json()).toEqual(firstBody);

      const changed = await external.post('/api/records/donation', { data: { ...body, amount: 502 }, headers });
      expect(changed.status()).toBe(422);
      expect(((await changed.json()) as { message: string }).message).toBe(reusedKey);

      const found = await external.post('/api/records/donation/query', { data: { search: donorName } });
      expect(found.status()).toBe(200);
      expect(((await found.json()) as { total: number }).total).toBe(1);
    } finally {
      await external.dispose();
    }
    const audited = await auditSince(admin, started, (e) => e.entityId === createdId && e.actorId === `api:${financeKeyName}`);
    expect(audited.length).toBeGreaterThan(0);
    expect(audited[0]!.actorName).toBe(financeKeyName);
  });

  test('FT-ADM-082 revoking the key asks first, and the key is refused afterwards', { tag: ['@e2e', '@FT-E2E-10', '@P0', '@smoke'] }, async ({ page }) => {
    test.skip(!viewerKey, 'FT-ADM-080 did not create the key.');
    test.setTimeout(90_000);
    await signIn(page, accounts.admin.email, accounts.admin.name);
    await page.goto('/admin/api-keys');
    await keyRow(page, viewerKeyName).getByRole('button', { name: label('ui.common.moreActions') }).click();
    await page.getByRole('menuitem', { name: label('ui.admin.keys.revoke') }).click();
    const confirm = page.getByRole('dialog', { name: label('ui.admin.keys.revokeTitle', { name: viewerKeyName }) });
    await expect(confirm.getByText(label('ui.admin.keys.revokeNote'))).toBeVisible();
    await confirm.getByRole('button', { name: label('ui.admin.keys.revoke'), exact: true }).click();
    await expect(page.getByText(label('ui.admin.keys.revokedMsg', { name: viewerKeyName }))).toBeVisible();
    await expect(keyRow(page, viewerKeyName)).toHaveCount(0);

    const external = await asKey(viewerKey!);
    try {
      const res = await external.post('/api/records/donor/query', { data: {} });
      expect(res.status()).toBe(403);
      expect(((await res.json()) as { message: string }).message).toBe(invalidKey);
    } finally {
      await external.dispose();
    }
    expect((await keyView(admin, viewerKey!.id))?.revokedAt).not.toBeNull();
  });

  test('FT-RUN-023 a webhook connector delivers a request signed with x-ngo-signature that the receiver verifies', { tag: ['@e2e', '@FT-E2E-10', '@P1'] }, async () => {
    const tls = fixtureTlsDir();
    test.skip(!hasFixtureTls(tls), `No fixture certificate in ${tls}. ${receiverEnv}`);
    receiver = await startWebhookReceiver(tls, signingSecret);
    const saved = await admin.put(`/api/admin/connectors/${connectorKey}`, {
      data: { kind: 'webhook', enabled: true, config: { url: receiver.url }, secrets: { signingSecret } },
    });
    expect(saved.status(), await saved.text()).toBe(200);

    const res = await admin.post(`/api/admin/connectors/${connectorKey}/test`, { data: {} });
    expect(res.status()).toBe(200);
    const result = (await res.json()) as { ok: boolean; status: number | null; error?: string };
    test.skip(!result.ok && receiver.received.length === 0, `The connector could not reach ${receiver.url}: ${result.error ?? ''}. ${receiverEnv}`);
    expect(result).toMatchObject({ ok: true, status: 200 });

    expect(receiver.received).toHaveLength(1);
    const hook = receiver.received[0]!;
    expect(hook.headers['x-ngo-event']).toBe('connector.test');
    expect(hook.headers['x-ngo-signature']).toBe(`sha256=${createHmac('sha256', signingSecret).update(hook.body).digest('hex')}`);
    expect(hook.verified).toBe(true);
    const payload = JSON.parse(hook.body) as { event: string; organisation: unknown };
    expect(payload.event).toBe('connector.test');
    expect(payload.organisation).toBeTruthy();

    const log = await admin.get(`/api/admin/connectors/${connectorKey}/deliveries`, { params: { limit: '5' } });
    expect(log.status()).toBe(200);
    const [latest] = (await log.json()) as { event: string; status: string; responseStatus: number | null }[];
    expect(latest).toMatchObject({ event: 'connector.test', status: 'sent', responseStatus: 200 });
    delivered = true;
  });

  test('FT-E2E-10 data was masked for the Viewer key, the retry made no duplicate, and the signed webhook was received', { tag: ['@e2e', '@FT-E2E-10', '@P0'] }, async () => {
    test.skip(!viewerKey || !financeKey, 'The keys were not created.');
    expect((await keyView(admin, viewerKey!.id))?.revokedAt).not.toBeNull();
    const finance = await asKey(financeKey!);
    try {
      const found = await finance.post('/api/records/donation/query', { data: { search: donorName } });
      expect(((await found.json()) as { total: number }).total).toBe(1);
    } finally {
      await finance.dispose();
    }
    test.skip(!delivered, `The webhook leg did not run. ${receiverEnv}`);
    expect(receiver?.received.filter((r) => r.verified)).toHaveLength(1);
  });
});

function asKey(key: CreatedKey): Promise<APIRequestContext> {
  const dot = key.token.indexOf('.');
  return keyApi(key.token.slice(0, dot), key.token.slice(dot + 1));
}

async function keyView(admin: APIRequestContext, id: string): Promise<KeyView | undefined> {
  const res = await admin.get('/api/admin/api-keys');
  expect(res.status()).toBe(200);
  return ((await res.json()) as KeyView[]).find((k) => k.id === id);
}

/** The list row for a key: the innermost element holding both its name and its ⋮ menu. */
function keyRow(page: Page, name: string) {
  return page
    .locator('div, li, tr, article')
    .filter({ hasText: name })
    .filter({ has: page.getByRole('button', { name: label('ui.common.moreActions') }) })
    .last();
}
