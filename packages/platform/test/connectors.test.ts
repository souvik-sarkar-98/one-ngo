import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectorRequest, ConnectorResponse } from '../src/infrastructure/connectors/http.js';
import { buildServer } from '@onengo/server/http/server.js';
import { hmacSha256 } from '@onengo/kernel/crypto';
import { pkceChallenge } from '@onengo/kernel/oidc';
import { rfc822 } from '../src/application/connectors/rfc822.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { admin, clerk, createWorld, expectCode, type TestWorld } from './helpers.js';

/** Records every outbound request and answers from a script; nothing reaches the network. */
const calls: ConnectorRequest[] = [];
let answers: (ConnectorResponse | Error)[] = [];
const fakeHttp = async (req: ConnectorRequest): Promise<ConnectorResponse> => {
  calls.push(req);
  const next = answers.shift() ?? { status: 200, body: '{"ok":true}' };
  if (next instanceof Error) throw next;
  return next;
};

const SIGNING = 'whsec-very-secret-1';
const SMS_KEY = 'sms-api-key-2';
const WA_TOKEN = 'wa-access-token-3';
const SECRETS = [SIGNING, SMS_KEY, WA_TOKEN];

let w: TestWorld;
const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
const donation = async (data: Record<string, unknown> = {}) =>
  (await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Meera', amount: 500, ...data })).record;
const saveHook = (patch: Record<string, unknown> = {}) =>
  w.platform.connectors.save(w.as(w.ngoA), 'crm', { kind: 'webhook', config: { url: 'https://crm.test/hooks' }, ...patch });
const deliveries = (key: string) => w.platform.connectors.deliveries(w.as(w.ngoA), key);
/** Makes queued work due now, so the next run retries without waiting for the backoff. */
const dueNow = () => w.platform.db.asSystem((tx) => tx.query(`update outbox_event set available_at = now() where status = 'pending'`));
const outbox = (type: string) =>
  w.platform.db.asSystem((tx) =>
    tx.query<{ status: string; attempts: number }>(`select status, attempts from outbox_event where tenant_id = $1 and type = $2 order by created_at`, [w.ngoA, type]),
  );

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, connectorHttp: fakeHttp });
  await saveHook({ secrets: { signingSecret: SIGNING }, enabled: true });
  await publish('action', {
    key: 'tellCrm',
    recordType: 'donation',
    label: 'Tell the CRM',
    placement: ['panel'],
    steps: [{ type: 'webhook', connector: 'crm', body: { amount: 'record.amount', who: 'record.donorName' } }],
  });
  await publish('template', {
    key: 'phoneNote',
    subject: 'Thanks',
    body: 'Thank you "{{ record.donorName }}" for {{ record.amount }}',
    whatsapp: { name: 'donation_thanks', language: 'hi', parameters: ['record.donorName', 'record.amount'] },
  });
  await publish('action', {
    key: 'textDonor',
    recordType: 'donation',
    label: 'Text the donor',
    placement: ['panel'],
    steps: [{ type: 'notify', template: 'phoneNote', to: { phone: "'+91 98765-43210'" }, channels: ['sms', 'whatsapp'] }],
  });
});
afterAll(() => w.close());
beforeEach(async () => {
  await w.platform.dispatcher.runOnce();
  calls.length = 0;
  answers = [];
});

describe('connector settings', () => {
  it('stores secrets encrypted and never returns them', async () => {
    const view = await w.platform.connectors.get(w.as(w.ngoA), 'crm');
    expect(view).toMatchObject({ key: 'crm', kind: 'webhook', enabled: true, configured: true, config: { url: 'https://crm.test/hooks' }, secrets: ['signingSecret'] });
    expect(JSON.stringify(view)).not.toContain(SIGNING);
    const [row] = await w.platform.db.asSystem((tx) =>
      tx.query<{ secret_enc: string }>(`select secret_enc from connector where tenant_id = $1 and key = 'crm'`, [w.ngoA]),
    );
    expect(row!.secret_enc).not.toContain(SIGNING);
    const audit = await w.platform.db.asSystem((tx) =>
      tx.query<{ after: unknown }>(`select after from audit_event where tenant_id = $1 and action = 'connector.saved'`, [w.ngoA]),
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(SIGNING);
    expect(row!.secret_enc.startsWith('v1.')).toBe(true);
  });

  it('keeps stored secrets when they are not sent again, and removes one sent as null', async () => {
    await w.platform.connectors.save(w.as(w.ngoA), 'spare', { kind: 'webhook', config: { url: 'https://spare.test/' }, secrets: { signingSecret: 'x1', extra: 'x2' } });
    const kept = await w.platform.connectors.save(w.as(w.ngoA), 'spare', { config: { url: 'https://spare.test/v2' }, secrets: { extra: null } });
    expect(kept).toMatchObject({ kind: 'webhook', enabled: false, config: { url: 'https://spare.test/v2' }, secrets: ['signingSecret'] });
  });

  it('validates settings per kind', async () => {
    const issues = async (key: string, body: Record<string, unknown>) =>
      ((await expectCode(w.platform.connectors.save(w.as(w.ngoA), key, body), 'validation_failed')) as Error & { issues: { path: string }[] }).issues.map((i) => i.path);
    expect(await issues('hook2', { kind: 'webhook', config: { url: 'http://plain.test/' } })).toContain('/config/url');
    expect(await issues('hook2', { kind: 'webhook', config: { url: 'https://ok.test/' }, enabled: true })).toEqual(['/secrets/signingSecret']);
    expect(await issues('hook2', { kind: 'pager', config: {} })).toEqual(['/kind']);
    expect(await issues('crm', { kind: 'sms' })).toEqual(['/kind']);
    expect(
      await issues('sms2', { kind: 'sms', config: { url: 'https://sms.test/?k={{secrets.missing}}', method: 'PUT', headers: { 'Bad Header': 'x' }, extra: 1 } }),
    ).toEqual(expect.arrayContaining(['/config/url', '/config/method', '/config/headers/Bad Header', '/config/extra']));
    expect(await issues('wa2', { kind: 'whatsapp', config: { baseUrl: 'ftp://wa.test', phoneNumberId: 'abc' } })).toEqual(['/config/baseUrl', '/config/phoneNumberId']);
    await expectCode(w.platform.connectors.save(w.as(w.ngoA), 'Bad Key', { kind: 'webhook', config: { url: 'https://ok.test/' } }), 'validation_failed');
  });

  it('leaves payment and sign-in connectors to their own settings', async () => {
    await w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`insert into connector (tenant_id, key, type) values (app_tenant(), 'razorpay', 'razorpay')`));
    await expectCode(w.platform.connectors.get(w.as(w.ngoA), 'razorpay'), 'not_found');
    await expectCode(w.platform.connectors.save(w.as(w.ngoA), 'razorpay', { kind: 'webhook', config: { url: 'https://x.test/' } }), 'rule_violation');
  });

  it('needs admin:connectors and stays inside the organisation', async () => {
    await expectCode(w.platform.connectors.get(w.as(w.ngoA, clerk), 'crm'), 'forbidden');
    await expectCode(w.platform.connectors.save(w.as(w.ngoA, clerk), 'crm', { enabled: false }), 'forbidden');
    await expectCode(w.platform.connectors.test(w.as(w.ngoA, clerk), 'crm'), 'forbidden');
    await expectCode(w.platform.connectors.deliveries(w.as(w.ngoA, clerk), 'crm'), 'forbidden');
    const scoped: Actor = { id: 'ops', roles: [], permissions: ['admin:connectors'] };
    expect((await w.platform.connectors.get(w.as(w.ngoA, scoped), 'crm')).key).toBe('crm');
    await expectCode(w.platform.connectors.get(w.as(w.ngoB), 'crm'), 'not_found');
  });
});

describe('webhooks', () => {
  it('posts a signed JSON body with the record, event, organisation and time', async () => {
    const d = await donation({ donorName: 'Ravi', amount: 750 });
    await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'tellCrm', { input: {} });
    expect(calls).toHaveLength(0);
    await w.platform.dispatcher.runOnce();
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req).toMatchObject({ url: 'https://crm.test/hooks', method: 'POST' });
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['x-ngo-event']).toBe('action.tellCrm');
    expect(req.headers['x-ngo-signature']).toBe(`sha256=${hmacSha256(SIGNING, req.body!)}`);
    expect(req.headers['x-ngo-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: 'action.tellCrm',
      organisation: { id: w.ngoA, key: 'asha', name: 'Asha Trust' },
      record: { id: d.id, type: 'donation', number: d.number, status: 'raised' },
      data: { amount: 750, who: 'Ravi' },
      actorId: admin.id,
    });
    expect(new Date(String(body.time)).toISOString()).toBe(body.time);
    expect(JSON.stringify(body)).not.toContain(SIGNING);
    const [log] = await deliveries('crm');
    expect(log).toMatchObject({ event: 'action.tellCrm', recordId: d.id, status: 'sent', attempts: 1, responseStatus: 200, error: null });
  });

  it('retries failed deliveries with backoff, logging each attempt on one row', async () => {
    answers = [{ status: 503, body: 'busy' }, new Error('socket hang up'), { status: 202, body: '' }];
    const d = await donation();
    await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'tellCrm', { input: {} });
    expect((await w.platform.dispatcher.runOnce()).retried).toBe(1);
    expect((await deliveries('crm'))[0]).toMatchObject({ recordId: d.id, status: 'pending', attempts: 1, responseStatus: 503 });
    expect((await deliveries('crm'))[0]!.error).toContain('503');
    expect((await w.platform.dispatcher.runOnce()).retried).toBe(0);
    expect(calls).toHaveLength(1);

    await dueNow();
    await w.platform.dispatcher.runOnce();
    expect((await deliveries('crm'))[0]).toMatchObject({ status: 'pending', attempts: 2, responseStatus: null, error: 'socket hang up' });
    await dueNow();
    await w.platform.dispatcher.runOnce();
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.body)).size).toBe(1);
    expect(new Set(calls.map((c) => c.headers['x-ngo-delivery'])).size).toBe(1);
    const logs = (await deliveries('crm')).filter((l) => l.recordId === d.id);
    expect(logs).toEqual([expect.objectContaining({ status: 'sent', attempts: 3, responseStatus: 202, error: null })]);
  });

  it('gives up after the last attempt and marks the delivery failed', async () => {
    answers = Array.from({ length: 5 }, () => ({ status: 500, body: 'down' }));
    const d = await donation();
    await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'tellCrm', { input: {} });
    for (let i = 0; i < 5; i++) {
      await dueNow();
      await w.platform.dispatcher.runOnce();
    }
    expect(calls).toHaveLength(5);
    expect((await deliveries('crm')).find((l) => l.recordId === d.id)).toMatchObject({ status: 'failed', attempts: 5, responseStatus: 500 });
    expect((await outbox('connector.webhook')).at(-1)).toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('runs webhook steps from automations through the same delivery', async () => {
    await publish('automation', {
      key: 'syncNew',
      recordType: 'donation',
      trigger: { event: 'created' },
      condition: "record.notes == 'sync'",
      actions: [{ type: 'webhook', connector: 'crm', body: { donor: 'record.donorName' } }],
    });
    const d = await donation({ donorName: 'Asha', notes: 'sync' });
    await w.platform.dispatcher.runOnce();
    const sent = calls.filter((c) => c.headers['x-ngo-event'] === 'automation.syncNew');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['x-ngo-signature']).toBe(`sha256=${hmacSha256(SIGNING, sent[0]!.body!)}`);
    expect(JSON.parse(sent[0]!.body!)).toMatchObject({ record: { id: d.id }, data: { donor: 'Asha' }, actorId: 'system:automation:syncNew' });
  });

  it('refuses to publish steps that name a connector that does not exist, or phone channels without a phone', async () => {
    const actionIssues = await expectCode(
      publish('action', { key: 'ghostHook', recordType: 'donation', label: 'Ghost', placement: ['panel'], steps: [{ type: 'webhook', connector: 'ghost' }] }),
      'definition_invalid',
    );
    expect(JSON.stringify((actionIssues as Error & { issues: unknown }).issues)).toContain("webhook connector 'ghost' does not exist");
    const autoIssues = await expectCode(
      publish('automation', {
        key: 'ghostAuto',
        recordType: 'donation',
        trigger: { event: 'created' },
        actions: [
          { type: 'webhook', connector: 'ghost' },
          { type: 'notify', template: 'phoneNote', to: { roles: ['admin'] }, channels: ['sms'] },
        ],
      }),
      'definition_invalid',
    );
    const messages = JSON.stringify((autoIssues as Error & { issues: unknown }).issues);
    expect(messages).toContain("webhook connector 'ghost' does not exist");
    expect(messages).toContain('sms need a phone recipient');
  });
});

describe('disabled or missing connectors never call', () => {
  it('logs webhook events for a disabled connector without sending them', async () => {
    await saveHook({ enabled: false });
    try {
      const d = await donation();
      await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'tellCrm', { input: {} });
      const result = await w.platform.dispatcher.runOnce();
      expect(result.retried).toBe(0);
      expect(calls).toEqual([]);
      expect((await deliveries('crm'))[0]).toMatchObject({ recordId: d.id, status: 'failed', attempts: 0, error: 'Not sent: the connector is not enabled.' });
      await expectCode(w.platform.connectors.test(w.as(w.ngoA), 'crm'), 'rule_violation');
      expect(calls).toEqual([]);
    } finally {
      await saveHook({ enabled: true });
    }
  });

  it('skips SMS and WhatsApp when the organisation has no enabled connector for them', async () => {
    await w.platform.connectors.save(w.as(w.ngoA), 'gateway', {
      kind: 'sms',
      config: { url: 'https://sms.test/send', method: 'POST', body: '{"to":"{{to}}","text":"{{message}}"}' },
      enabled: false,
    });
    const d = await donation({ donorName: 'Kiran' });
    await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'textDonor', { input: {} });
    await w.platform.dispatcher.runOnce();
    expect(calls).toEqual([]);
    const rows = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ channel: string; status: string; error: string }>(`select channel, status, error from notification where record_id = $1 order by channel`, [d.id]),
    );
    expect(rows).toEqual([
      { channel: 'sms', status: 'skipped', error: 'SMS is not configured for this organisation.' },
      { channel: 'whatsapp', status: 'skipped', error: 'WhatsApp is not configured for this organisation.' },
    ]);
  });
});

describe('SMS and WhatsApp notifications', () => {
  beforeAll(async () => {
    await w.platform.connectors.save(w.as(w.ngoA), 'gateway', {
      kind: 'sms',
      config: {
        url: 'https://sms.test/send?to={{to}}&key={{secrets.apiKey}}',
        method: 'POST',
        headers: { Authorization: 'Bearer {{secrets.apiKey}}' },
        body: '{"to":"{{to}}","text":"{{message}}"}',
        contentType: 'json',
      },
      secrets: { apiKey: SMS_KEY },
      enabled: true,
    });
    await w.platform.connectors.save(w.as(w.ngoA), 'wa', {
      kind: 'whatsapp',
      config: { baseUrl: 'https://wa.test/v20.0/', phoneNumberId: '1234567890' },
      secrets: { accessToken: WA_TOKEN },
      enabled: true,
    });
  });

  it('sends to the phone recipient through the generic SMS template and the WhatsApp Cloud API', async () => {
    const d = await donation({ donorName: 'Zoya', amount: 300 });
    await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'textDonor', { input: {} });
    await w.platform.dispatcher.runOnce();
    const sms = calls.find((c) => c.url.startsWith('https://sms.test/'))!;
    expect(sms).toMatchObject({
      url: `https://sms.test/send?to=%2B919876543210&key=${SMS_KEY}`,
      method: 'POST',
      headers: { authorization: `Bearer ${SMS_KEY}`, 'content-type': 'application/json' },
    });
    expect(JSON.parse(sms.body!)).toEqual({ to: '+919876543210', text: 'Thank you "Zoya" for 300' });
    const wa = calls.find((c) => c.url.startsWith('https://wa.test/'))!;
    expect(wa).toMatchObject({ url: 'https://wa.test/v20.0/1234567890/messages', method: 'POST', headers: { authorization: `Bearer ${WA_TOKEN}` } });
    expect(JSON.parse(wa.body!)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'donation_thanks',
        language: { code: 'hi' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Zoya' }, { type: 'text', text: '300' }] }],
      },
    });
    const rows = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ channel: string; status: string; to_address: string }>(`select channel, status, to_address from notification where record_id = $1 order by channel`, [d.id]),
    );
    expect(rows).toEqual([
      { channel: 'sms', status: 'sent', to_address: '+919876543210' },
      { channel: 'whatsapp', status: 'sent', to_address: '+919876543210' },
    ]);
    expect((await deliveries('gateway'))[0]).toMatchObject({ event: 'notification.sms', recordId: d.id, status: 'sent', attempts: 1 });
    expect((await deliveries('wa'))[0]).toMatchObject({ event: 'notification.whatsapp', recordId: d.id, status: 'sent' });
  });

  it('retries a failed message and keeps the notification pending until it is sent', async () => {
    const d = await donation({ donorName: 'Om' });
    answers = [{ status: 429, body: 'slow down' }, { status: 200, body: 'ok' }];
    await w.platform.notifications.notify(w.ngoA, {
      template: 'phoneNote',
      to: { phone: "'9876543210'" },
      channels: ['sms'],
      scope: { record: { donorName: 'Om', amount: 1 } },
      recordId: d.id,
    });
    expect((await w.platform.dispatcher.runOnce()).retried).toBe(1);
    const status = () =>
      w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ status: string }>(`select status from notification where record_id = $1 and channel = 'sms'`, [d.id]));
    expect(await status()).toEqual([{ status: 'pending' }]);
    await dueNow();
    await w.platform.dispatcher.runOnce();
    expect(await status()).toEqual([{ status: 'sent' }]);
    expect((await deliveries('gateway'))[0]).toMatchObject({ recordId: d.id, status: 'sent', attempts: 2, responseStatus: 200 });
  });
});

describe('http and oauth connectors', () => {
  const ACCESS = 'oauth-access-token-4';
  const save = (key: string, body: Record<string, unknown>) => w.platform.connectors.save(w.as(w.ngoA), key, body);
  const issues = async (key: string, body: Record<string, unknown>) =>
    ((await expectCode(save(key, body), 'validation_failed')) as Error & { issues: { path: string }[] }).issues.map((i) => i.path);
  const oauthConfig = { authorizationUrl: 'https://id.test/authorize', tokenUrl: 'https://id.test/token', clientId: 'client-1', scopes: ['mail.send'] };
  const sendConfig = { mode: 'send', method: 'POST', url: 'https://mail.test/send', body: '{"to":"{{message.to}}","raw":"{{ message.mime | base64url }}"}' };

  beforeAll(async () => {
    await save('mailer-id', { kind: 'oauth', config: oauthConfig, secrets: { clientSecret: 'client-secret-5', refreshToken: 'refresh-token-6' }, enabled: true });
  });

  it('refuses an http connector with a plain URL, an unknown placeholder or a credential that is not oauth', async () => {
    expect(await issues('h1', { kind: 'http', config: { ...sendConfig, url: 'http://mail.test/send' } })).toContain('/config/url');
    expect(await issues('h1', { kind: 'http', config: { ...sendConfig, body: '{{record.x}} {{nope.y}}' } })).toEqual(['/config/body']);
    expect(await issues('h1', { kind: 'http', config: { ...sendConfig, url: 'https://mail.test/?t={{credential.accessToken}}' } })).toEqual(['/config/url']);
    expect(await issues('h1', { kind: 'http', config: { ...sendConfig, credential: 'crm' } })).toEqual(['/config/credential']);
    expect(await issues('h1', { kind: 'http', config: { ...sendConfig, mode: 'lookup', method: 'PUT' } })).toEqual(
      expect.arrayContaining(['/config/method', '/config/inputs', '/config/responseMap', '/config/body']),
    );
  });

  it('allows one email sender per organisation, in send mode with a From address', async () => {
    const sender = { ...sendConfig, credential: 'mailer-id', headers: { Authorization: 'Bearer {{credential.accessToken}}' }, emailSender: true, from: 'office@asha.test' };
    await save('mail-out', { kind: 'http', config: sender, enabled: true });
    expect(await issues('mail-two', { kind: 'http', config: sender })).toEqual(['/config/emailSender']);
    expect(await issues('mail-two', { kind: 'http', config: { ...sender, from: undefined, mode: 'lookup' } })).toEqual(
      expect.arrayContaining(['/config/emailSender', '/config/from']),
    );
    expect((await save('mail-out', { config: { ...sender, from: 'info@asha.test' } })).config).toMatchObject({ from: 'info@asha.test' });
  });

  it('needs the client secret for oauth, and is configured only once connected', async () => {
    expect(await issues('id2', { kind: 'oauth', config: { ...oauthConfig, tokenUrl: 'http://id.test/token', scopes: [] } })).toEqual(['/config/tokenUrl', '/config/scopes']);
    expect(await issues('id2', { kind: 'oauth', config: oauthConfig, enabled: true })).toEqual(['/secrets/clientSecret']);
    const view = await save('id2', { kind: 'oauth', config: oauthConfig, secrets: { clientSecret: 'cs' }, enabled: true });
    expect(view).toMatchObject({ configured: false, oauth: { connected: false, expiresAt: null } });
    expect(await w.platform.connectors.test(w.as(w.ngoA), 'id2')).toMatchObject({ ok: false, error: expect.stringContaining('Reconnect needed') });
    expect(calls).toEqual([]);
    expect(await w.platform.connectors.get(w.as(w.ngoA), 'mailer-id')).toMatchObject({ configured: true, oauth: { connected: true, expiresAt: null } });
    expect((await w.platform.connectors.get(w.as(w.ngoA), 'crm')).oauth).toBeNull();
  });

  it('sends with a refreshed access token and redacts it from the logged error', async () => {
    answers = [{ status: 200, body: JSON.stringify({ access_token: ACCESS, expires_in: 3600 }) }, { status: 401, body: `token ${ACCESS} rejected` }];
    const result = await w.platform.connectors.test(w.as(w.ngoA), 'mail-out', { to: 'donor@x.test' });
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(result.error).not.toContain(ACCESS);
    expect(result.error).toContain('[redacted]');
    expect(calls.map((c) => c.url)).toEqual(['https://id.test/token', 'https://mail.test/send']);
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ to: 'donor@x.test' });
    const [log] = await deliveries('mail-out');
    expect(log).toMatchObject({ event: 'connector.test', status: 'failed', responseStatus: 401 });
    expect(log!.error).not.toContain(ACCESS);

    const view = await w.platform.connectors.get(w.as(w.ngoA), 'mailer-id');
    expect(view.oauth).toEqual({ connected: true, expiresAt: expect.any(String) });
    expect(JSON.stringify(view)).not.toContain(ACCESS);
    expect(await w.platform.connectors.test(w.as(w.ngoA), 'mailer-id')).toMatchObject({ ok: true, message: expect.stringContaining('renewed') });
    expect(calls).toHaveLength(2);
  });

  it('returns a failed result instead of calling a disabled http connector', async () => {
    await save('off-hook', { kind: 'http', config: { mode: 'send', method: 'POST', url: 'https://off.test/' } });
    const d = { eventId: null, event: 'test', recordId: null, final: true };
    expect(await w.platform.connectors.callHttp(w.ngoA, 'off-hook', {}, d)).toMatchObject({ ok: false, error: 'Not sent: the connector is not enabled.' });
    expect(await w.platform.connectors.callHttp(w.ngoA, 'nothing', {}, d)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it('looks up scalar values by JSON path and reports missing paths as field issues', async () => {
    await save('ifsc', {
      kind: 'http',
      config: { mode: 'lookup', method: 'GET', url: 'https://ifsc.test/{{record.ifsc}}', inputs: ['ifsc'], responseMap: { bank: 'BANK', city: 'address.city' } },
      enabled: true,
    });
    answers = [{ status: 200, body: '{"BANK":"State Bank","address":{"city":"Pune"}}' }];
    expect(await w.platform.connectors.lookup(w.ngoA, 'ifsc', { record: { ifsc: 'SBIN0001' } })).toEqual({ values: { bank: 'State Bank', city: 'Pune' } });
    expect(calls.at(-1)).toMatchObject({ url: 'https://ifsc.test/SBIN0001', method: 'GET', maxBodyBytes: 65536 });

    answers = [{ status: 200, body: '{"BANK":"State Bank","address":{"city":{"name":"Pune"}}}' }];
    expect(await w.platform.connectors.lookup(w.ngoA, 'ifsc', { record: { ifsc: 'X' } })).toEqual({ issues: [expect.objectContaining({ path: '/city' })] });
    answers = [{ status: 404, body: 'no such code' }];
    const missing = await w.platform.connectors.lookup(w.ngoA, 'ifsc', { record: { ifsc: 'X' } });
    expect('issues' in missing && missing.issues.map((i) => i.path)).toEqual(['/bank', '/city']);
    expect((await deliveries('ifsc')).slice(0, 3).map((d) => [d.event, d.status])).toEqual([
      ['lookup', 'failed'],
      ['lookup', 'failed'],
      ['lookup', 'sent'],
    ]);

    answers = [{ status: 200, body: '{"BANK":"HDFC","address":{"city":"Delhi"}}' }];
    expect(await w.platform.connectors.test(w.as(w.ngoA), 'ifsc', { inputs: { ifsc: 'HDFC0001' } })).toMatchObject({ ok: true, message: expect.stringContaining('HDFC') });
  });

  it('counts connector steps in published definitions as users', async () => {
    const list = await w.platform.connectors.list(w.as(w.ngoA), [{ label: 'Check bank', body: { steps: [{ type: 'connector', connector: 'ifsc' }] } }]);
    expect(list.find((c) => c.key === 'ifsc')?.usedBy).toEqual(['Check bank']);
  });

  it('refuses a lookup without inputs or a response map, or with a placeholder outside its inputs', async () => {
    const lookup = { mode: 'lookup', method: 'GET', url: 'https://ifsc.test/{{record.ifsc}}' };
    expect(await issues('look2', { kind: 'http', config: lookup })).toEqual(expect.arrayContaining(['/config/inputs', '/config/responseMap']));
    expect(await issues('look2', { kind: 'http', config: { ...lookup, inputs: ['code'], responseMap: { bank: 'BANK' } } })).toEqual(['/config/url']);
    expect(await issues('look2', { kind: 'http', config: { ...lookup, inputs: ['ifsc'], responseMap: { bank: 'BANK.' } } })).toEqual(['/config/responseMap/bank']);
    expect(await issues('look2', { kind: 'http', config: { ...lookup, inputs: ['ifsc'], responseMap: {} } })).toEqual(['/config/responseMap']);
  });

  it('redacts the access token from an answer that echoes it', async () => {
    answers = [{ status: 200, body: `{"sent":true,"token":"${ACCESS}"}` }];
    const d = { eventId: null, event: 'test', recordId: null, final: true };
    const result = await w.platform.connectors.callHttp(w.ngoA, 'mail-out', { message: { to: 'a@x.test' } }, d);
    expect(result).toMatchObject({ ok: true, status: 200, body: '{"sent":true,"token":"[redacted]"}' });
    expect(calls.map((c) => c.url)).toEqual(['https://mail.test/send']);
  });

  it("sends the organisation's email through the email sender as a base64url RFC 822 message, and through SMTP once it is disabled", async () => {
    const before = w.mail.sent.length;
    const send = (to: string) =>
      w.platform.notifications.notify(w.ngoA, { template: 'phoneNote', to: { email: `'${to}'` }, channels: ['email'], scope: { record: { donorName: 'Asha', amount: 5 } } });
    const bodyTo = async (to: string) =>
      (await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ subject: string; body: string; status: string }>(`select subject, body, status from notification where to_address = $1`, [to])))[0]!;

    await send('donor@x.test');
    await w.platform.dispatcher.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://mail.test/send', method: 'POST', headers: { authorization: `Bearer ${ACCESS}`, 'content-type': 'application/json' } });
    const n = await bodyTo('donor@x.test');
    expect(n).toMatchObject({ subject: 'Thanks', status: 'sent' });
    const sent = JSON.parse(calls[0]!.body!) as { to: string; raw: string };
    const mime = rfc822({ from: 'info@asha.test', to: 'donor@x.test', subject: 'Thanks', text: n.body });
    expect(sent).toEqual({ to: 'donor@x.test', raw: Buffer.from(mime, 'utf8').toString('base64url') });
    expect(sent.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(sent.raw, 'base64url').toString('utf8')).toContain('From: info@asha.test\r\nTo: donor@x.test\r\nSubject: Thanks\r\n');
    expect(w.mail.sent.length).toBe(before);
    expect((await deliveries('mail-out'))[0]).toMatchObject({ event: 'notification.email', status: 'sent', responseStatus: 200 });

    await save('mail-out', { enabled: false });
    try {
      await send('later@x.test');
      await w.platform.dispatcher.runOnce();
      expect(calls).toHaveLength(1);
      expect(w.mail.sent.slice(before)).toEqual([expect.objectContaining({ to: 'later@x.test', subject: 'Thanks' })]);
      expect(await bodyTo('later@x.test')).toMatchObject({ status: 'sent' });
    } finally {
      await save('mail-out', { enabled: true });
    }
  });

  it('stores HTML only on the email and sends that email as multipart', async () => {
    await publish('template', {
      key: 'htmlNote',
      subject: 'Hello {{ record.donorName }}',
      body: 'Plain {{ record.donorName }}',
      html: '<p onclick="alert(1)">Dear {{ record.donorName }}</p><script>alert(1)</script><table><tr><td style="color:red">Thanks</td></tr></table>',
      whatsapp: { name: 'donation_thanks', language: 'en', parameters: ['record.donorName'] },
    });
    const preview = await w.platform.builderSupport().previewTemplate(w.as(w.ngoA), {
      key: 'htmlNote',
      sample: { record: { donorName: 'Asha <b>' } },
    });
    expect(preview.subject).toBe('Hello Asha <b>');
    expect(preview.body).toBe('Plain Asha <b>');
    expect(preview.html).toContain('Asha &lt;b&gt;');
    expect(preview.html).not.toContain('<script');
    expect(preview.html).not.toContain('onclick');
    expect(preview.html).toContain('<table>');
    expect(preview.whatsapp).toEqual({ name: 'donation_thanks', language: 'en', parameters: ['Asha <b>'] });

    const [user] = await w.platform.db.asSystem((tx) =>
      tx.query<{ id: string }>(`insert into app_user (email, display_name) values ('html-user@example.org', 'Html User') returning id`),
    );
    await w.platform.db.asSystem((tx) => tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, user!.id]));
    await w.platform.notifications.notify(w.ngoA, {
      template: 'htmlNote',
      to: { users: [user!.id], phone: "'+919800011122'" },
      channels: ['inApp', 'email', 'sms'],
      scope: { record: { donorName: 'Asha <b>' } },
    });
    const rows = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ channel: string; body: string; html: string | null }>(
        `select channel, body, html from notification where subject = 'Hello Asha <b>'`,
      ),
    );
    const by = Object.fromEntries(rows.map((r) => [r.channel, r]));
    expect(by['email']).toMatchObject({ body: 'Plain Asha <b>' });
    expect(by['email']!.html).toContain('<table>');
    expect(by['email']!.html).toContain('Asha &lt;b&gt;');
    expect(by['inApp']).toMatchObject({ body: 'Plain Asha <b>', html: null });
    expect(by['sms']).toMatchObject({ body: 'Plain Asha <b>', html: null });

    await w.platform.dispatcher.runOnce();
    const sent = w.mail.sent.find((m) => m.to === 'html-user@example.org');
    const mime = calls
      .flatMap((c) => {
        try {
          const parsed = JSON.parse(c.body ?? '') as { raw?: string };
          return parsed.raw ? [Buffer.from(parsed.raw, 'base64url').toString('utf8')] : [];
        } catch {
          return [];
        }
      })
      .find((text) => text.includes('multipart/alternative'));
    if (sent) {
      expect(sent.text).toBe('Plain Asha <b>');
      expect(sent.html).toContain('<table>');
      expect(sent.html).toContain('Asha &lt;b&gt;');
    } else {
      expect(mime).toContain('multipart/alternative');
      expect(mime).toContain('Content-Type: text/html; charset=utf-8');
      expect(mime).toContain('Plain Asha <b>');
      expect(mime).toContain('Asha &lt;b&gt;');
    }
  });
});

describe('oauth connect and refresh', () => {
  const config = { authorizationUrl: 'https://id.test/authorize?tenant=asha', tokenUrl: 'https://id.test/token', clientId: 'client-9', scopes: ['mail.send', 'offline'] };
  const CLIENT_SECRET = 'cs-google-8';
  const REDIRECT = 'https://ngo.test/api/connectors/oauth/callback';
  const d = { eventId: null, event: 'test', recordId: null, final: true };
  let app: ReturnType<typeof buildServer>;
  const headers = (actor: Actor = admin) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
  const form = (req: ConnectorRequest) => Object.fromEntries(new URLSearchParams(req.body ?? ''));
  const start = (key: string, actor: Actor = admin) => app.inject({ method: 'POST', url: `/api/admin/connectors/${key}/oauth/start`, headers: headers(actor) });
  const callback = (query: Record<string, string>) => app.inject({ method: 'GET', url: `/api/connectors/oauth/callback?${new URLSearchParams(query)}` });
  /** Connects `google` with the token answer given, as the provider's redirect would. */
  const connect = async (token: Record<string, unknown>) => {
    const res = await start('google');
    expect(res.statusCode, res.body).toBe(200);
    const url = new URL((res.json() as { url: string }).url);
    answers = [{ status: 200, body: JSON.stringify(token) }];
    const back = await callback({ code: 'code-1', state: url.searchParams.get('state')! });
    return { url, back };
  };

  beforeAll(async () => {
    app = buildServer(w.platform, { devAuth: true });
    await w.platform.connectors.save(w.as(w.ngoA), 'google', { kind: 'oauth', config, secrets: { clientSecret: CLIENT_SECRET }, enabled: true });
    await w.platform.connectors.save(w.as(w.ngoA), 'google-api', {
      kind: 'http',
      config: { mode: 'send', method: 'POST', url: 'https://api.test/send', credential: 'google', headers: { Authorization: 'Bearer {{credential.accessToken}}' } },
      enabled: true,
    });
  });
  afterAll(() => app.close());

  it('starts at the provider with PKCE, and the callback exchanges the code once and stores the tokens', async () => {
    expect((await start('google', clerk)).statusCode).toBe(403);
    const { url, back } = await connect({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    expect(`${url.origin}${url.pathname}`).toBe('https://id.test/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      tenant: 'asha',
      client_id: 'client-9',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'mail.send offline',
      code_challenge_method: 'S256',
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/admin/connectors/google?connected=1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://id.test/token', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const sent = form(calls[0]!);
    expect(sent).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT, client_id: 'client-9', client_secret: CLIENT_SECRET });
    expect(pkceChallenge(sent.code_verifier!)).toBe(url.searchParams.get('code_challenge'));
    expect(await w.platform.connectors.get(w.as(w.ngoA), 'google')).toMatchObject({
      configured: true,
      secrets: ['accessToken', 'accessTokenExpiresAt', 'clientSecret', 'refreshToken'],
      oauth: { connected: true, expiresAt: expect.any(String) },
    });

    const again = await callback({ code: 'code-1', state: url.searchParams.get('state')! });
    expect(again.headers.location).toBe('/admin/connectors?error=1');
    expect(calls).toHaveLength(1);
  });

  it('sends the administrator back with an error when the provider refuses, without calling the token endpoint', async () => {
    const res = await start('google');
    const state = new URL((res.json() as { url: string }).url).searchParams.get('state')!;
    const back = await callback({ error: 'access_denied', state });
    expect(back.headers.location).toBe('/admin/connectors/google?error=denied');
    expect(calls).toEqual([]);
  });

  it('refreshes an expiring token once when two calls need it at the same time', async () => {
    await connect({ access_token: 'at-short', refresh_token: 'rt-2', expires_in: 30 });
    calls.length = 0;
    answers = [{ status: 200, body: JSON.stringify({ access_token: 'at-fresh', expires_in: 3600 }) }, { status: 200, body: 'ok' }, { status: 200, body: 'ok' }];
    const both = await Promise.all([1, 2].map(() => w.platform.connectors.callHttp(w.ngoA, 'google-api', {}, d)));
    expect(both).toEqual([expect.objectContaining({ ok: true, status: 200 }), expect.objectContaining({ ok: true, status: 200 })]);
    const token = calls.filter((c) => c.url === 'https://id.test/token');
    expect(token).toHaveLength(1);
    expect(form(token[0]!)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-2', client_id: 'client-9', client_secret: CLIENT_SECRET });
    expect(calls.filter((c) => c.url === 'https://api.test/send').map((c) => c.headers.authorization)).toEqual(['Bearer at-fresh', 'Bearer at-fresh']);

    calls.length = 0;
    expect(await w.platform.connectors.callHttp(w.ngoA, 'google-api', {}, d)).toMatchObject({ ok: true });
    expect(calls.map((c) => c.url)).toEqual(['https://api.test/send']);
  });

  it('reports a refused refresh as a credential that needs reconnecting, and calls nothing else', async () => {
    await connect({ access_token: 'at-old', refresh_token: 'rt-3', expires_in: 1 });
    calls.length = 0;
    answers = [{ status: 400, body: '{"error":"invalid_grant","error_description":"rt-3 was revoked"}' }];
    const result = await w.platform.connectors.callHttp(w.ngoA, 'google-api', {}, d);
    expect(result).toEqual({ ok: false, status: null, body: '', error: 'credential needs reconnect' });
    expect((await deliveries('google-api'))[0]).toMatchObject({ event: 'test', status: 'failed', responseStatus: null, error: 'credential needs reconnect' });

    answers = [{ status: 400, body: '{"error":"invalid_grant"}' }];
    const tested = await w.platform.connectors.test(w.as(w.ngoA), 'google');
    expect(tested).toMatchObject({ ok: false, status: null, error: expect.stringContaining('Reconnect needed') });
    expect(calls.map((c) => c.url)).toEqual(['https://id.test/token', 'https://id.test/token']);
    expect(JSON.stringify(await w.platform.connectors.deliveries(w.as(w.ngoA), 'google-api'))).not.toContain('rt-3');
  });
});

describe('http send steps', () => {
  const KEY = 'slack-key-7';
  beforeAll(async () => {
    await w.platform.connectors.save(w.as(w.ngoA), 'slack', {
      kind: 'http',
      config: { mode: 'send', method: 'POST', url: `https://slack.test/hook?k={{secrets.key}}`, body: '{"text":"{{record.who}} gave {{record.amount}}"}' },
      secrets: { key: KEY },
      enabled: true,
    });
    await publish('action', {
      key: 'tellSlack',
      recordType: 'donation',
      label: 'Tell Slack',
      placement: ['panel'],
      steps: [{ type: 'connector', connector: 'slack', body: { who: 'record.donorName' } }],
    });
  });

  it('queues the call after the action and retries it up to five attempts, then marks it failed', async () => {
    answers = Array.from({ length: 6 }, () => ({ status: 500, body: `down ${KEY}` }));
    const d = await donation({ donorName: 'Ravi', amount: 900 });
    await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'tellSlack', { input: {} });
    expect(calls).toHaveLength(0);
    for (let i = 0; i < 5; i++) {
      await dueNow();
      await w.platform.dispatcher.runOnce();
      expect(calls).toHaveLength(i + 1);
    }
    expect(calls[0]).toMatchObject({ url: `https://slack.test/hook?k=${KEY}`, method: 'POST' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ text: 'Ravi gave 900' });
    expect(new Set(calls.map((c) => c.body)).size).toBe(1);
    const logs = (await deliveries('slack')).filter((l) => l.recordId === d.id);
    expect(logs).toEqual([expect.objectContaining({ event: 'action.tellSlack', status: 'failed', attempts: 5, responseStatus: 500 })]);
    expect(logs[0]!.error).toContain('500');
    expect(logs[0]!.error).not.toContain(KEY);
    expect((await outbox('connector.http')).at(-1)).toMatchObject({ status: 'failed', attempts: 5 });

    await dueNow();
    await w.platform.dispatcher.runOnce();
    expect(calls).toHaveLength(5);
  });

  it('sends once and logs one sent delivery when the service answers', async () => {
    const d = await donation({ donorName: 'Uma', amount: 40 });
    await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'tellSlack', { input: {} });
    await w.platform.dispatcher.runOnce();
    expect(calls).toHaveLength(1);
    expect((await deliveries('slack')).filter((l) => l.recordId === d.id)).toEqual([expect.objectContaining({ status: 'sent', attempts: 1, responseStatus: 200 })]);
    expect((await outbox('connector.http')).at(-1)).toMatchObject({ status: 'done', attempts: 1 });
  });
});

describe('HTTP routes', () => {
  it('serve settings, tests and deliveries without ever returning a secret', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
    const responses: string[] = [];
    const call = async (method: 'GET' | 'PUT' | 'POST', url: string, payload?: Record<string, unknown>, actor: Actor = admin) => {
      const res = await app.inject({ method, url, headers: headers(actor), ...(payload ? { payload } : {}) });
      responses.push(res.body);
      return res;
    };

    const put = await call('PUT', '/api/admin/connectors/notify-hook', {
      kind: 'webhook',
      config: { url: 'https://hooks.test/in' },
      secrets: { signingSecret: SIGNING },
      enabled: true,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ key: 'notify-hook', kind: 'webhook', enabled: true, configured: true, secrets: ['signingSecret'] });
    expect((await call('GET', '/api/admin/connectors/notify-hook')).json()).toMatchObject({ config: { url: 'https://hooks.test/in' } });
    expect((await call('GET', '/api/admin/connectors/gateway')).json()).toMatchObject({ kind: 'sms', secrets: ['apiKey'] });
    expect((await call('GET', '/api/admin/connectors/wa')).json()).toMatchObject({ kind: 'whatsapp', secrets: ['accessToken'] });

    const test = await call('POST', '/api/admin/connectors/notify-hook/test', {});
    expect(test.json()).toEqual({ ok: true, status: 200 });
    const req = calls.at(-1)!;
    expect(req.headers['x-ngo-signature']).toBe(`sha256=${hmacSha256(SIGNING, req.body!)}`);
    expect(JSON.parse(req.body!)).toMatchObject({ event: 'connector.test', organisation: { key: 'asha' } });

    answers = [{ status: 401, body: 'bad token' }];
    const failed = await call('POST', '/api/admin/connectors/wa/test', { to: '+91 99999 00000' });
    expect(failed.json()).toMatchObject({ ok: false, status: 401 });
    expect((await call('POST', '/api/admin/connectors/gateway/test', { to: 'not a phone' })).statusCode).toBe(422);

    const logs = await call('GET', '/api/admin/connectors/notify-hook/deliveries?limit=10');
    expect(logs.statusCode).toBe(200);
    expect(logs.json()).toEqual([expect.objectContaining({ event: 'connector.test', status: 'sent', attempts: 1, responseStatus: 200 })]);
    expect((await call('GET', '/api/admin/connectors/wa/deliveries')).json()[0]).toMatchObject({ event: 'connector.test', status: 'failed', responseStatus: 401 });

    expect((await call('GET', '/api/admin/connectors/notify-hook', undefined, clerk)).statusCode).toBe(403);
    expect((await call('PUT', '/api/admin/connectors/notify-hook', { enabled: false }, clerk)).statusCode).toBe(403);
    expect((await call('POST', '/api/admin/connectors/notify-hook/test', {}, clerk)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/connectors/notify-hook/deliveries', undefined, clerk)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/connectors/nothing')).statusCode).toBe(404);
    expect((await call('PUT', '/api/admin/connectors/bad-hook', { kind: 'webhook', config: { url: 'http://x.test' } })).statusCode).toBe(422);

    for (const body of responses) for (const secret of SECRETS) expect(body).not.toContain(secret);
    await app.close();
  });
});
