import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CashfreeProvider, RazorpayProvider, type HttpPost } from '../src/infrastructure/payments/providers.js';
import { buildServer } from '@onengo/server/http/server.js';
import { hmacSha256 } from '@onengo/kernel/crypto';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { admin, clerk, completeIdentity, createWorld, type TestWorld } from './helpers.js';

const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
const fakePost: HttpPost = async (url, init) => {
  calls.push({ url, ...init });
  const body = url.includes('razorpay') ? { id: `order_gw_${calls.length}` } : { order_id: JSON.parse(init.body).order_id, payment_session_id: 'sess_gw' };
  return { status: 200, json: async () => body };
};

const RAZORPAY = { keyId: 'rzp_test_gateway', keySecret: 'rzp-key-secret-never-shown', webhookSecret: 'rzp-webhook-secret-never-shown' };
const CASHFREE = { keyId: 'cf_client_gateway', keySecret: 'cf-client-secret-never-shown' };
const SECRETS = [RAZORPAY.keySecret, RAZORPAY.webhookSecret, CASHFREE.keySecret];
const treasurer: Actor = { id: 'treasurer-1', roles: [], permissions: ['payments:configure'] };
const onPaid = { transition: 'markPaid', fields: { paidOn: 'paidOn', reference: 'reference', method: 'method' } };

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await createWorld({ paymentProviders: [new RazorpayProvider(fakePost), new CashfreeProvider(fakePost)] });
  await completeIdentity(w, w.ngoA);
  app = buildServer(w.platform, { devAuth: true });
  for (const provider of ['razorpay', 'cashfree'] as const) {
    const key = `pay${provider[0]!.toUpperCase()}${provider.slice(1)}`;
    const action = { key, recordType: 'donation', label: key, placement: ['panel'], steps: [{ type: 'createPayment', provider, amount: 'record.amount', account: 'bank', onPaid }] };
    await w.platform.definitions.saveDraft(w.as(w.ngoA), 'action', action as never);
    await w.platform.definitions.publish(w.as(w.ngoA), 'action', key);
  }
});
afterAll(async () => {
  await app.close();
  await w.close();
});

const as = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, actor: Actor = admin) =>
  app.inject({ method, url, headers: as(actor), ...(payload === undefined ? {} : { payload: payload as object }) });

async function orderIdOf(intentId: string): Promise<string> {
  const [row] = await w.platform.db.withTenant(w.ngoA, (tx) =>
    tx.query<{ provider_order_id: string }>(`select provider_order_id from payment_intent where id = $1`, [intentId]),
  );
  return row!.provider_order_id;
}

async function payableDonation(provider: 'razorpay' | 'cashfree', amount: number) {
  const { record } = await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: `${provider} donor`, amount });
  const created = await call('POST', '/api/payments', { recordId: record.id, action: `pay${provider[0]!.toUpperCase()}${provider.slice(1)}` });
  expect(created.statusCode, created.body).toBe(201);
  expect(created.json()).toMatchObject({ provider, amount: amount.toFixed(2) });
  for (const secret of SECRETS) expect(created.body).not.toContain(secret);
  const intent = created.json() as { id: string };
  return { recordId: record.id, intentId: intent.id, orderId: await orderIdOf(intent.id) };
}

describe('payment gateway set-up', () => {
  it('needs payments:configure to save or list', async () => {
    expect((await call('PUT', '/api/admin/payment-gateways/razorpay', RAZORPAY, clerk)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/payment-gateways', undefined, clerk)).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/payment-gateways', undefined, treasurer)).json()).toEqual([
      { provider: 'razorpay', configured: false, enabled: false, keyId: null, environment: null },
      { provider: 'cashfree', configured: false, enabled: false, keyId: null, environment: null },
    ]);

    const saved = await call('PUT', '/api/admin/payment-gateways/razorpay', RAZORPAY, treasurer);
    expect(saved.statusCode, saved.body).toBe(204);
    expect(saved.body).toBe('');
    const audit = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ actor_id: string }>(`select actor_id from audit_event where action = 'connector.saved' and entity_id = 'razorpay'`),
    );
    expect(audit.map((a) => a.actor_id)).toContain(treasurer.id);
  });

  it('lists each provider with its key id and environment, never a secret', async () => {
    const saved = await call('PUT', '/api/admin/payment-gateways/cashfree', CASHFREE);
    expect(saved.statusCode, saved.body).toBe(204);
    const listed = await call('GET', '/api/admin/payment-gateways');
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      { provider: 'razorpay', configured: true, enabled: true, keyId: RAZORPAY.keyId, environment: null },
      { provider: 'cashfree', configured: true, enabled: true, keyId: CASHFREE.keyId, environment: 'sandbox' },
    ]);
    for (const url of ['/api/admin/payment-gateways', '/api/admin/connectors', '/api/admin/audit?limit=200']) {
      const res = await call('GET', url);
      expect(res.statusCode, url).toBe(200);
      for (const secret of SECRETS) expect(res.body, url).not.toContain(secret);
    }
  });

  it('drops secrets from the list even if the service were to return them', async () => {
    const real = await w.platform.payments.gateways(w.as(w.ngoA));
    const spy = vi.spyOn(w.platform.payments, 'gateways').mockResolvedValueOnce(real.map((g) => ({ ...g, keySecret: RAZORPAY.keySecret })));
    const res = await call('GET', '/api/admin/payment-gateways');
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(real);
    expect(res.body).not.toContain(RAZORPAY.keySecret);
  });

  it.each([
    ['razorpay without a webhook secret', 'razorpay', { keyId: 'k', keySecret: 's' }, '/webhookSecret'],
    ['an empty key secret', 'razorpay', { ...RAZORPAY, keySecret: '' }, '/keySecret'],
    ['a field that is not part of the request', 'razorpay', { ...RAZORPAY, environment: 'sandbox' }, '/environment'],
    ['cashfree without a client secret', 'cashfree', { keyId: 'k' }, '/keySecret'],
    ['an unknown environment', 'cashfree', { ...CASHFREE, environment: 'live' }, '/environment'],
    ['null for an optional field', 'cashfree', { ...CASHFREE, webhookSecret: null }, '/webhookSecret'],
    ['a key id that is not text', 'cashfree', { ...CASHFREE, keyId: 42 }, '/keyId'],
  ])('answers 400 for %s', async (_what, provider, body, path) => {
    const res = await call('PUT', `/api/admin/payment-gateways/${provider}`, body);
    expect(res.statusCode, res.body).toBe(400);
    expect(JSON.stringify(res.json())).toContain(path);
  });

  it('answers 400 when the body is missing or not an object, and 404 for an unknown provider', async () => {
    for (const payload of [undefined, '[]', '"text"', '{ nope']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/payment-gateways/razorpay',
        headers: { ...as(admin), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, String(payload)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'bad_request' });
    }
    expect((await call('PUT', '/api/admin/payment-gateways/stripe', RAZORPAY)).statusCode).toBe(404);
    expect((await call('GET', '/api/admin/payment-gateways')).json()).toContainEqual(expect.objectContaining({ keyId: RAZORPAY.keyId }));
  });
});

describe('requesting a payment through a published action', () => {
  it('takes the amount from the action, needs its permission, and refuses actions that take no payment', async () => {
    expect((await call('PUT', '/api/admin/payment-gateways/razorpay', RAZORPAY)).statusCode).toBe(204);
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Route donor', amount: 1234.5 });
    const collector: Actor = { id: 'collector-gw', roles: [], permissions: ['record:donation:read', 'payments:create'] };
    expect((await call('POST', '/api/payments', { recordId: record.id, action: 'payRazorpay' }, collector)).statusCode).toBe(403);
    expect((await call('POST', '/api/payments', { recordId: record.id, action: 'printReceipt' })).statusCode).toBe(422);
    expect((await call('POST', '/api/payments', { recordId: record.id, action: 'nope' })).statusCode).toBe(404);
    const created = await call('POST', '/api/payments', { recordId: record.id, action: 'payRazorpay' }, { ...collector, permissions: [...collector.permissions, 'record:donation:action:payRazorpay'] });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ recordId: record.id, provider: 'razorpay', amount: '1234.50', status: 'awaiting_payment' });
  });
});

describe('webhooks verified with the credentials saved through the route', () => {
  it('Razorpay: a webhook signed with the saved webhook secret pays the record, a forged one is refused', async () => {
    expect((await call('PUT', '/api/admin/payment-gateways/razorpay', RAZORPAY)).statusCode).toBe(204);
    const { recordId, intentId, orderId } = await payableDonation('razorpay', 640);
    expect(calls.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from(`${RAZORPAY.keyId}:${RAZORPAY.keySecret}`).toString('base64')}`);

    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_gw_1', order_id: orderId, amount: 64000 } } } });
    const send = (secret: string) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/payments/razorpay/asha',
        headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmacSha256(secret, body), 'x-razorpay-event-id': 'evt_gw_1' },
        payload: body,
      });
    const forged = await send(RAZORPAY.keySecret);
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toEqual({ ok: false });
    const good = await send(RAZORPAY.webhookSecret);
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ ok: true });

    await w.platform.dispatcher.runOnce();
    expect((await call('GET', `/api/payments/${intentId}`)).json()).toMatchObject({ status: 'paid' });
    expect(await w.platform.records.get(w.as(w.ngoA), recordId)).toMatchObject({ status: 'paid', data: { reference: 'pay_gw_1', method: 'online' } });
  });

  it('Cashfree: orders go to the sandbox and a webhook signed with the saved client secret pays the record', async () => {
    expect((await call('PUT', '/api/admin/payment-gateways/cashfree', CASHFREE)).statusCode).toBe(204);
    const { recordId, intentId, orderId } = await payableDonation('cashfree', 250);
    expect(calls.at(-1)!.url).toMatch(/^https:\/\/sandbox\.cashfree\.com\//);
    expect(calls.at(-1)!.headers).toMatchObject({ 'x-client-id': CASHFREE.keyId, 'x-client-secret': CASHFREE.keySecret });

    const body = JSON.stringify({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: { order: { order_id: orderId, order_amount: 250 }, payment: { cf_payment_id: 7001, payment_status: 'SUCCESS', payment_amount: 250 } },
    });
    const ts = String(Date.now());
    const send = (secret: string) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/payments/cashfree/asha',
        headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': hmacSha256(secret, ts + body, 'base64') },
        payload: body,
      });
    expect((await send('not-the-client-secret')).statusCode).toBe(401);
    const good = await send(CASHFREE.keySecret);
    expect(good.statusCode).toBe(200);

    await w.platform.dispatcher.runOnce();
    expect((await call('GET', `/api/payments/${intentId}`)).json()).toMatchObject({ status: 'paid' });
    expect(await w.platform.records.get(w.as(w.ngoA), recordId)).toMatchObject({ status: 'paid', data: { reference: '7001' } });
  });

  it('Cashfree: refuses a correctly signed webhook whose timestamp is more than five minutes old', async () => {
    expect((await call('PUT', '/api/admin/payment-gateways/cashfree', CASHFREE)).statusCode).toBe(204);
    const { intentId, orderId } = await payableDonation('cashfree', 75);
    const body = JSON.stringify({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: { order: { order_id: orderId, order_amount: 75 }, payment: { cf_payment_id: 7002, payment_status: 'SUCCESS', payment_amount: 75 } },
    });
    const ts = String(Date.now() - 6 * 60_000);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/payments/cashfree/asha',
      headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts, 'x-webhook-signature': hmacSha256(CASHFREE.keySecret, ts + body, 'base64') },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect((await call('GET', `/api/payments/${intentId}`)).json()).toMatchObject({ status: 'awaiting_payment' });
  });

  it('switches Cashfree to production when saved that way', async () => {
    expect((await call('PUT', '/api/admin/payment-gateways/cashfree', { ...CASHFREE, environment: 'production' })).statusCode).toBe(204);
    expect((await call('GET', '/api/admin/payment-gateways')).json()).toContainEqual(expect.objectContaining({ provider: 'cashfree', environment: 'production' }));
    await payableDonation('cashfree', 99);
    expect(calls.at(-1)!.url).toMatch(/^https:\/\/api\.cashfree\.com\//);
  });
});
