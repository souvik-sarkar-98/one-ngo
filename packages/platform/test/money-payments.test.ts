import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RecordService } from '../src/runtime/records/record-service.js';
import type { TenantContext } from '../src/domain/ports/tenant-context.js';
import { CashfreeProvider, RazorpayProvider, type HttpPost } from '../src/infrastructure/payments/providers.js';
import { TRANSFER_MATRIX_SETTING } from '../src/domain/accounts/money-account-service.js';
import { buildServer } from '@onengo/server/http/server.js';
import { hmacSha256 } from '@onengo/kernel/crypto';
import { admin, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
const fakePost: HttpPost = async (url, init) => {
  calls.push({ url, ...init });
  const body = url.includes('razorpay') ? { id: `order_${calls.length}` } : { order_id: JSON.parse(init.body).order_id, payment_session_id: 'sess_1' };
  return { status: 200, json: async () => body };
};

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld({ paymentProviders: [new RazorpayProvider(fakePost), new CashfreeProvider(fakePost)] });
  const ctx = w.as(w.ngoA);
  await completeIdentity(w, w.ngoA);
  await w.platform.moneyAccounts.open(ctx, { key: 'main', name: 'SBI current', kind: 'bank', upiId: 'asha.trust@sbi' });
  await w.platform.moneyAccounts.open(ctx, { key: 'petty', name: 'Petty cash', kind: 'cash', custodian: 'Office' });
  await w.platform.moneyAccounts.open(ctx, { key: 'ravi', name: 'Ravi wallet', kind: 'wallet' });
  for (const [key, provider] of [['payByUpi', 'upi'], ['payByCard', 'razorpay']] as const) {
    const action = { key, recordType: 'donation', label: key, placement: ['panel'], steps: [{ type: 'createPayment', provider, amount: 'record.amount', account: 'main', onPaid }] };
    await w.platform.definitions.saveDraft(ctx, 'action', action as never);
    await w.platform.definitions.publish(ctx, 'action', key);
  }
});
afterAll(() => w.close());

const onPaid = { transition: 'markPaid', fields: { paidOn: 'paidOn', reference: 'reference', method: 'method' } };

describe('money accounts', () => {
  it('moves money between accounts through balanced journal entries', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.moneyAccounts.transfer(ctx, { from: 'main', to: 'petty', amount: 2000, date: today(), reference: 'ATM' });
    await w.platform.moneyAccounts.transfer(ctx, { from: 'petty', to: 'ravi', amount: 500.25, date: today() });
    const balances = Object.fromEntries((await w.platform.moneyAccounts.list(ctx)).map((a) => [a.key, a.balance]));
    expect(balances).toEqual({ main: '-2000.00', petty: '1499.75', ravi: '500.25' });
  });

  it('does not let cash or wallets go below zero', async () => {
    const err = await expectCode(
      w.platform.moneyAccounts.transfer(w.as(w.ngoA), { from: 'ravi', to: 'petty', amount: 600, date: today() }),
      'rule_violation',
    );
    expect(err.message).toMatch(/only 500.25 available/);
  });

  it('enforces the configured transfer matrix', async () => {
    await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query(`insert into tenant_setting (tenant_id, key, value) values (app_tenant(), $1, $2)`, [
        TRANSFER_MATRIX_SETTING,
        JSON.stringify([['bank', 'cash'], ['cash', 'bank']]),
      ]),
    );
    await expectCode(w.platform.moneyAccounts.transfer(w.as(w.ngoA), { from: 'petty', to: 'ravi', amount: 1, date: today() }), 'rule_violation');
    await w.platform.moneyAccounts.transfer(w.as(w.ngoA), { from: 'petty', to: 'main', amount: 1, date: today() });
  });

  it('only closes an account with a zero balance', async () => {
    await expectCode(w.platform.moneyAccounts.close(w.as(w.ngoA), 'ravi'), 'rule_violation');
  });
});

describe('UPI payments with no gateway fee', () => {
  it('builds a UPI link to the NGO account and confirms by hand: donation paid, posted, and receipted', async () => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'UPI donor', amount: 751 });
    const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 751, provider: 'upi_direct', onPaid, upiAccountKey: 'main' });
    expect(intent.upiLink).toMatch(/^upi:\/\/pay\?pa=asha.trust%40sbi&pn=Asha\+Trust&am=751.00&cu=INR&tn=NGO[A-Z0-9]{8}/);
    await expectCode(
      w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 751, provider: 'upi_direct', onPaid, upiAccountKey: 'main' }),
      'rule_violation',
    );

    await w.platform.payments.confirmManually(ctx, intent.id, { paidOn: today(), bankReference: 'UTR123' });
    await w.platform.dispatcher.runOnce();
    const after = await w.platform.records.get(ctx, record.id);
    expect(after).toMatchObject({ status: 'paid', data: { method: 'upi', reference: 'UTR123', paidOn: today() } });
    const receipts = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), record.id));
    expect(receipts).toHaveLength(1);
    await expectCode(w.platform.payments.confirmManually(ctx, intent.id, { paidOn: today() }), 'rule_violation');
  });

  it('matches bank statement lines by reference and amount', async () => {
    const ctx = w.as(w.ngoA);
    const a = await w.platform.records.create(ctx, 'donation', { donorName: 'Statement A', amount: 300 });
    const b = await w.platform.records.create(ctx, 'donation', { donorName: 'Statement B', amount: 400 });
    const ia = await w.platform.payments.createIntent(ctx, { recordId: a.record.id, amount: 300, provider: 'upi_direct', onPaid, upiAccountKey: 'main' });
    const ib = await w.platform.payments.createIntent(ctx, { recordId: b.record.id, amount: 400, provider: 'upi_direct', onPaid, upiAccountKey: 'main' });
    const result = await w.platform.payments.matchStatement(ctx, [
      { date: today(), amount: 300, description: `UPI/CR/123/${ia.reference.toLowerCase()}/okaxis` },
      { date: today(), amount: 999, description: `UPI/CR/456/${ib.reference}` },
      { date: today(), amount: 50, description: 'Interest' },
    ]);
    expect(result).toEqual({ matched: [ia.id], unmatched: 2 });
    await w.platform.dispatcher.runOnce();
    expect((await w.platform.records.get(ctx, a.record.id)).status).toBe('paid');
    expect((await w.platform.records.get(ctx, b.record.id)).status).toBe('raised');
  });
});

describe('payment gateways', () => {
  const webhookSecret = 'whsec_test_123';

  it('stores gateway secrets encrypted and creates an order', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.payments.saveGatewayCredentials(ctx, 'razorpay', { keyId: 'rzp_test_key', keySecret: 'rzp_secret', webhookSecret });
    const [stored] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ config: unknown; secret_enc: string }>(`select config, secret_enc from connector where key = 'razorpay'`),
    );
    expect(JSON.stringify(stored)).not.toContain('rzp_secret');
    expect(JSON.stringify(stored)).not.toContain(webhookSecret);

    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Card donor', amount: 1200 });
    const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 1200, provider: 'razorpay', onPaid });
    expect(intent.checkout).toMatchObject({ provider: 'razorpay', key: 'rzp_test_key', amount: 120000 });
    expect(JSON.stringify(intent.checkout)).not.toContain('rzp_secret');
    expect(calls.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from('rzp_test_key:rzp_secret').toString('base64')}`);
  });

  it('accepts only correctly signed webhooks, once, and pays the record', async () => {
    const [intent] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ provider_order_id: string; record_id: string }>(
        `select provider_order_id, record_id from payment_intent where provider = 'razorpay' and status = 'awaiting_payment'`,
      ),
    );
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: intent!.provider_order_id, amount: 120000 } } },
    });
    const good = { 'x-razorpay-signature': hmacSha256(webhookSecret, body), 'x-razorpay-event-id': 'evt_1' };
    expect(await w.platform.payments.handleWebhook('asha', 'razorpay', body, { ...good, 'x-razorpay-signature': 'bad' })).toBe(false);
    expect(await w.platform.payments.handleWebhook('bodhi', 'razorpay', body, good)).toBe(false);
    expect(await w.platform.payments.handleWebhook('asha', 'razorpay', body, good)).toBe(true);
    expect(await w.platform.payments.handleWebhook('asha', 'razorpay', body, good)).toBe(true);
    await w.platform.dispatcher.runOnce();

    const record = await w.platform.records.get(w.as(w.ngoA), intent!.record_id);
    expect(record).toMatchObject({ status: 'paid', data: { reference: 'pay_1', method: 'online' } });
    const events = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`select 1 from payment_event where provider = 'razorpay'`));
    expect(events).toHaveLength(1);
  });

  it('holds a payment for review when the amount does not match', async () => {
    const ctx = w.as(w.ngoA, admin);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Short pay', amount: 500 });
    const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 500, provider: 'razorpay', onPaid });
    const [row] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ provider_order_id: string }>(`select provider_order_id from payment_intent where id = $1`, [intent.id]),
    );
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_2', order_id: row!.provider_order_id, amount: 100 } } },
    });
    await w.platform.payments.handleWebhook('asha', 'razorpay', body, {
      'x-razorpay-signature': hmacSha256(webhookSecret, body),
      'x-razorpay-event-id': 'evt_2',
    });
    expect((await w.platform.payments.get(ctx, intent.id)).status).toBe('awaiting_payment');
  });

  it('checks the webhook signature over the exact bytes sent, which only the webhook route keeps', async () => {
    const ctx = w.as(w.ngoA, admin);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Raw bytes', amount: 13 });
    const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 13, provider: 'razorpay', onPaid });
    const [row] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ provider_order_id: string }>(`select provider_order_id from payment_intent where id = $1`, [intent.id]),
    );
    const body = `{ "event" : "payment.captured",\n  "notes": { "z": 1, "7": 2 },\n  "payload": {"payment": {"entity": {"id": "pay_3", "order_id": "${row!.provider_order_id}", "amount": 1300}}} }\n`;
    const reserialized = JSON.stringify(JSON.parse(body));
    expect(reserialized).not.toBe(body);

    const app = buildServer(w.platform);
    app.post('/echo', async (req) => ({ body: req.body, hasRawBody: 'rawBody' in req }));
    try {
      const url = '/webhooks/payments/razorpay/asha';
      const send = (signedOver: string, eventId: string) =>
        app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmacSha256(webhookSecret, signedOver), 'x-razorpay-event-id': eventId },
          payload: body,
        });
      const tampered = await send(reserialized, 'evt_3');
      expect(tampered.statusCode).toBe(401);
      const exact = await send(body, 'evt_3');
      expect(exact.statusCode).toBe(200);
      expect(exact.json()).toEqual({ ok: true });
      await w.platform.dispatcher.runOnce();
      expect((await w.platform.records.get(ctx, record.id)).status).toBe('paid');

      const echo = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: body });
      expect(echo.json()).toEqual({ body: JSON.parse(body), hasRawBody: false });
      const empty = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '' });
      expect(empty.json()).toEqual({ body: {}, hasRawBody: false });
      const invalid = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{ nope' });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('verifies Cashfree webhook signatures over timestamp and body', () => {
    const provider = new CashfreeProvider(fakePost);
    const creds = { keyId: 'cf_id', keySecret: 'cf_secret', webhookSecret: 'unused' };
    const body = JSON.stringify({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: { order: { order_id: 'NGO123', order_amount: 10 }, payment: { cf_payment_id: 99, payment_status: 'SUCCESS', payment_amount: 10 } },
    });
    const ts = String(Date.now());
    const event = provider.parseWebhook(body, { 'x-webhook-timestamp': ts, 'x-webhook-signature': hmacSha256('cf_secret', ts + body, 'base64') }, creds);
    expect(event).toMatchObject({ kind: 'paid', orderId: 'NGO123', paymentId: '99', amountPaise: 1000 });
    expect(provider.parseWebhook(body, { 'x-webhook-timestamp': ts, 'x-webhook-signature': 'nope' }, creds)).toBeNull();
  });
});

describe('webhook hardening (S4-16)', () => {
  it('takes the Razorpay event id from the signed body, not the unsigned header', () => {
    const provider = new RazorpayProvider(fakePost);
    const creds = { keyId: 'k', keySecret: 's', webhookSecret: 'whsec' };
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_9', order_id: 'order_9', amount: 100 } } } });
    const signed = (eventId: string) => provider.parseWebhook(body, { 'x-razorpay-signature': hmacSha256('whsec', body), 'x-razorpay-event-id': eventId }, creds);
    expect(signed('evt_a')!.eventId).toBe('payment.captured:pay_9');
    expect(signed('evt_b')!.eventId).toBe(signed('evt_a')!.eventId);
  });

  it('accepts a Cashfree webhook only within five minutes of its signed timestamp', () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0);
    const provider = new CashfreeProvider(fakePost, () => now);
    const creds = { keyId: 'cf_id', keySecret: 'cf_secret', webhookSecret: 'unused' };
    const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'NGO1', order_amount: 1 }, payment: { cf_payment_id: 1, payment_status: 'SUCCESS', payment_amount: 1 } } });
    const at = (ts: string) => provider.parseWebhook(body, { 'x-webhook-timestamp': ts, 'x-webhook-signature': hmacSha256('cf_secret', ts + body, 'base64') }, creds);
    expect(at(String(now - 4 * 60_000))).not.toBeNull();
    expect(at(String(Math.floor((now + 4 * 60_000) / 1000)))).not.toBeNull();
    expect(at(String(now - 6 * 60_000))).toBeNull();
    expect(at(String(now + 6 * 60_000))).toBeNull();
    expect(at('yesterday')).toBeNull();
  });

  it('holds a paid webhook that does not say how much was paid', async () => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'No amount', amount: 321 });
    const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 321, provider: 'razorpay', onPaid });
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_noamt', order_id: await orderOf(intent.id) } } } });
    expect(await w.platform.payments.handleWebhook('asha', 'razorpay', body, { 'x-razorpay-signature': hmacSha256('whsec_test_123', body) })).toBe(true);
    expect((await w.platform.payments.get(ctx, intent.id)).status).toBe('awaiting_payment');
    expect(await auditOf(intent.id, 'payment.amount_mismatch')).toEqual([expect.objectContaining({ received: null, reason: 'The provider did not say how much was paid.' })]);
  });
});

async function orderOf(intentId: string): Promise<string> {
  const [row] = await w.platform.db.withTenant(w.ngoA, (tx) =>
    tx.query<{ provider_order_id: string }>(`select provider_order_id from payment_intent where id = $1`, [intentId]),
  );
  return row!.provider_order_id;
}

async function auditOf(intentId: string, action: string): Promise<Record<string, unknown>[]> {
  const rows = await w.platform.db.withTenant(w.ngoA, (tx) =>
    tx.query<{ after: Record<string, unknown> }>(`select after from audit_event where entity_id = $1 and action = $2`, [intentId, action]),
  );
  return rows.map((r) => r.after);
}

describe('payment terms come from the published definitions (S4-1)', () => {
  it('refuses an amount other than what the receipt will carry', async () => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Short ask', amount: 751 });
    const err = await expectCode(
      w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 1, provider: 'upi_direct', onPaid, upiAccountKey: 'main' }),
      'rule_violation',
    );
    expect(err.message).toBe("The payment is for 1.00 but the record's receipt would be for 751.00.");
  });

  it('refuses a paid step, provider or account that no published action asks for', async () => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Odd step', amount: 100 });
    const ask = { recordId: record.id, amount: 100, provider: 'upi_direct' as const, onPaid, upiAccountKey: 'main' };
    for (const odd of [{ onPaid: { ...onPaid, methodValue: 'cash' } }, { onPaid: { transition: 'markPaid' } }, { upiAccountKey: 'petty' }, { provider: 'cashfree' as const }]) {
      await expectCode(w.platform.payments.createIntent(ctx, { ...ask, ...odd }), 'rule_violation');
    }
  });

  it('needs the permission of the action that asks for the payment', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Permitted', amount: 200 });
    const ask = { recordId: record.id, amount: 200, provider: 'upi_direct' as const, onPaid, upiAccountKey: 'main' };
    const collector = { id: 'collector-2', roles: [], permissions: ['record:donation:read', 'payments:create'] };
    await expectCode(w.platform.payments.createIntent(w.as(w.ngoA, collector), ask), 'forbidden');
    const allowed = { ...collector, permissions: [...collector.permissions, 'record:donation:action:payByUpi'] };
    expect((await w.platform.payments.createIntent(w.as(w.ngoA, allowed), ask)).amount).toBe('200.00');
  });

  it('refuses every kind of confirmation once the record would be receipted for another amount', async () => {
    const ctx = w.as(w.ngoA);
    const raise = async (name: string, provider: 'upi_direct' | 'razorpay') => {
      const { record } = await w.platform.records.create(ctx, 'donation', { donorName: name, amount: 500 });
      const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 500, provider, onPaid, upiAccountKey: 'main' });
      await w.platform.records.update(ctx, record.id, { data: { amount: 50000 }, expectedVersion: record.version });
      return { record, intent };
    };

    const byHand = await raise('Raised later', 'upi_direct');
    const err = await expectCode(w.platform.payments.confirmManually(ctx, byHand.intent.id, { paidOn: today() }), 'rule_violation');
    expect(err.message).toBe("The payment is for 500.00 but the record's receipt would be for 50000.00.");
    const line = { date: today(), amount: 500, description: `UPI/${byHand.intent.reference}` };
    expect(await w.platform.payments.matchStatement(ctx, [line])).toEqual({ matched: [], unmatched: 1 });
    expect((await w.platform.payments.get(ctx, byHand.intent.id)).status).toBe('awaiting_payment');

    const online = await raise('Raised later online', 'razorpay');
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_late', order_id: await orderOf(online.intent.id), amount: 50000 } } } });
    expect(await w.platform.payments.handleWebhook('asha', 'razorpay', body, { 'x-razorpay-signature': hmacSha256('whsec_test_123', body) })).toBe(true);
    expect((await w.platform.payments.get(ctx, online.intent.id)).status).toBe('awaiting_payment');
    expect(await auditOf(online.intent.id, 'payment.amount_mismatch')).toEqual([
      expect.objectContaining({ expected: '500.00', reason: "The payment is for 500.00 but the record's receipt would be for 50000.00." }),
    ]);
  });

  it('runs the paid step as the payments system path with only the step permission, not unrestricted rights', async () => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Narrow rights', amount: 640 });
    const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 640, provider: 'upi_direct', onPaid, upiAccountKey: 'main' });
    await w.platform.payments.confirmManually(ctx, intent.id, { paidOn: today() });
    const spy = vi.spyOn(Object.getPrototypeOf(w.platform.records) as RecordService, 'transition');
    let calls: unknown[][] = [];
    try {
      await w.platform.dispatcher.runOnce();
      calls = [...spy.mock.calls];
    } finally {
      spy.mockRestore();
    }
    const actor = (calls.find((c) => c[1] === record.id)?.[0] as TenantContext).actor;
    expect(actor).toEqual({
      id: 'system:payments:upi_direct',
      roles: ['system'],
      permissions: ['record:donation:transition:markPaid', 'record:donation:read', 'record:donation:read:all'],
    });
    expect((await w.platform.records.get(ctx, record.id)).status).toBe('paid');
  });

  it('does not run the paid step when the record changed after confirmation', async () => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Changed after', amount: 900 });
    const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 900, provider: 'upi_direct', onPaid, upiAccountKey: 'main' });
    await w.platform.payments.confirmManually(ctx, intent.id, { paidOn: today(), bankReference: 'UTR900' });
    await w.platform.records.update(ctx, record.id, { data: { amount: 90000 }, expectedVersion: record.version });
    await w.platform.dispatcher.runOnce();

    expect((await w.platform.records.get(ctx, record.id)).status).toBe('raised');
    const receipts = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), record.id));
    expect(receipts).toEqual([]);
    expect(await auditOf(intent.id, 'payment.paid_step_refused')).toEqual([
      { reason: 'The payment is for 900.00 but the receipt would be for 90000.00.', amount: '900.00' },
    ]);
    const pending = await w.platform.db.asSystem((tx) =>
      tx.query(`select 1 from outbox_event where tenant_id = $1 and type = 'payment.confirmed' and status <> 'done' and payload->>'intentId' = $2`, [w.ngoA, intent.id]),
    );
    expect(pending).toEqual([]);
  });
});
