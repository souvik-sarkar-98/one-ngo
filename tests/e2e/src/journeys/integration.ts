import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type APIRequestContext } from '@playwright/test';
import { org } from '../accounts.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** The integration fixture's Razorpay demo keys (`apps/service-sandbox/server/src/constants.ts`). */
export const razorpayFixture = { keyId: 'rzp_test_demo', keySecret: 'demo-key-secret', webhookSecret: 'demo-webhook-secret' } as const;

/** Donor name the journey's own Razorpay action is offered for, so its button shows on no one else's donations. */
export const gatewayDonor = 'E2E Gateway Donor';

/** A published donation action whose `createPayment` step asks Razorpay; the shipped Pay now asks for UPI. */
export const gatewayActionKey = process.env.E2E_RAZORPAY_ACTION ?? 'e2eGatewayPay';

/** Today as the server's `today()` sees it: a UTC date. */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Rupees with paise, unique enough to pick this run's receipt and posting out of the audit log. */
export function uniqueAmount(base: number): number {
  return Number((base + ((Date.now() % 97) + 1) / 100).toFixed(2));
}

export interface Donation {
  id: string;
  number: string | null;
  status: string | null;
  data: Record<string, unknown>;
}

export async function createDonation(api: APIRequestContext, data: Record<string, unknown>): Promise<Donation> {
  const res = await api.post('/api/records/donation', { data });
  expect(res.status(), `create donation ${JSON.stringify(data)}`).toBe(201);
  return ((await res.json()) as { record: Donation }).record;
}

export async function donation(api: APIRequestContext, id: string): Promise<Donation> {
  const res = await api.get(`/api/records/donation/${id}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as Donation;
}

export async function donationStatus(api: APIRequestContext, id: string): Promise<string | null> {
  return (await donation(api, id)).status;
}

export async function receipts(api: APIRequestContext, id: string): Promise<{ id: string; number: string; amount: string; status: string }[]> {
  const res = await api.get(`/api/records/donation/${id}/receipts`);
  expect(res.status()).toBe(200);
  return (await res.json()) as { id: string; number: string; amount: string; status: string }[];
}

export interface Intent {
  id: string;
  recordId: string;
  provider: string;
  amount: string;
  reference: string;
  status: 'awaiting_payment' | 'paid' | 'failed' | 'cancelled';
  upiLink: string | null;
  checkout: { orderId?: string } | null;
}

export async function intent(api: APIRequestContext, id: string): Promise<Intent> {
  const res = await api.get(`/api/payments/${id}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as Intent;
}

export interface AuditEntry {
  at: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  after: Record<string, unknown> | null;
}

/** The newest audit events, filtered here; the API pages at most 200. */
export async function auditSince(admin: APIRequestContext, since: Date, match: (e: AuditEntry) => boolean): Promise<AuditEntry[]> {
  const res = await admin.get('/api/admin/audit', { params: { limit: '200' } });
  expect(res.status()).toBe(200);
  const { items } = (await res.json()) as { items: AuditEntry[] };
  return items.filter((e) => new Date(e.at) >= since && match(e));
}

/**
 * Razorpay set up for the organisation with a webhook secret the test knows: the
 * fixture's demo keys when it is not set up or already uses them, or
 * E2E_RAZORPAY_WEBHOOK_SECRET for a gateway set up some other way.
 */
export async function razorpayWebhookSecret(admin: APIRequestContext): Promise<{ secret: string } | { blocked: string }> {
  const fromEnv = process.env.E2E_RAZORPAY_WEBHOOK_SECRET;
  if (fromEnv) return { secret: fromEnv };
  const res = await admin.get('/api/admin/payment-gateways');
  if (res.status() !== 200) return { blocked: `GET /api/admin/payment-gateways answered ${res.status()}.` };
  const razorpay = ((await res.json()) as { provider: string; configured: boolean; keyId: string | null }[]).find((g) => g.provider === 'razorpay');
  if (razorpay?.configured && razorpay.keyId !== razorpayFixture.keyId) {
    return { blocked: `Razorpay is set up for ${org} with key ${razorpay.keyId}; set E2E_RAZORPAY_WEBHOOK_SECRET to its webhook secret.` };
  }
  const saved = await admin.put('/api/admin/payment-gateways/razorpay', { data: razorpayFixture });
  if (saved.status() !== 204) return { blocked: `Saving the fixture Razorpay keys answered ${saved.status()}.` };
  return { secret: razorpayFixture.webhookSecret };
}

/** The Razorpay donation action: E2E_RAZORPAY_ACTION when given, else this journey's own, published once. */
export async function ensureGatewayAction(admin: APIRequestContext): Promise<string | null> {
  const published = await admin.get(`/api/definitions/action/${gatewayActionKey}`);
  if (published.status() === 200) return null;
  if (process.env.E2E_RAZORPAY_ACTION) return `E2E_RAZORPAY_ACTION=${gatewayActionKey} is not a published action.`;
  const body = {
    key: gatewayActionKey,
    recordType: 'donation',
    label: 'Pay online (E2E)',
    placement: ['panel'],
    when: `status == 'raised' and record.donorName == '${gatewayDonor}'`,
    steps: [
      {
        type: 'createPayment',
        provider: 'razorpay',
        amount: 'record.amount',
        onPaid: { transition: 'markPaid', fields: { paidOn: 'paidOn', reference: 'reference', method: 'method' }, methodValue: 'online' },
      },
    ],
  };
  const draft = await admin.put(`/api/builder/definitions/action/${gatewayActionKey}/draft`, { data: body });
  if (draft.status() !== 200) return `Saving the Razorpay action draft answered ${draft.status()}: ${await draft.text()}`;
  const publish = await admin.post(`/api/builder/definitions/action/${gatewayActionKey}/publish`, { data: {} });
  if (publish.status() !== 200) return `Publishing the Razorpay action answered ${publish.status()}: ${await publish.text()}`;
  return null;
}

/** Pay now pays into the money account `upi`; it needs a UPI ID. */
export async function ensureUpiAccount(admin: APIRequestContext): Promise<string | null> {
  const res = await admin.get('/api/money/accounts');
  if (res.status() !== 200) return `GET /api/money/accounts answered ${res.status()}.`;
  const upi = ((await res.json()) as { key: string; upiId: string | null; status: string }[]).find((a) => a.key === 'upi');
  if (upi) return upi.upiId && upi.status === 'active' ? null : 'The money account "upi" has no UPI ID or is closed, so Pay now cannot build a UPI link.';
  const opened = await admin.post('/api/money/accounts', { data: { key: 'upi', name: 'UPI collections', kind: 'bank', upiId: `${org}@upi` } });
  return opened.status() === 201 ? null : `Opening the money account "upi" answered ${opened.status()}: ${await opened.text()}`;
}

export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

/** A Razorpay `payment.captured` or `payment.failed` event, signed the way the fixture signs it. A null amount leaves it out. */
export function razorpayWebhook(
  orderId: string,
  amountPaise: number | null,
  outcome: 'captured' | 'failed',
  secret: string,
): SignedWebhook {
  const payment: Record<string, unknown> = { id: `pay_e2e${randomBytes(7).toString('hex')}`, entity: 'payment', currency: 'INR', status: outcome, order_id: orderId, method: 'upi' };
  if (amountPaise !== null) payment.amount = amountPaise;
  const body = JSON.stringify({
    entity: 'event',
    account_id: 'acc_demo',
    event: outcome === 'captured' ? 'payment.captured' : 'payment.failed',
    contains: ['payment'],
    payload: { payment: { entity: payment } },
    created_at: Math.floor(Date.now() / 1000),
  });
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', secret).update(body).digest('hex'),
      'x-razorpay-event-id': `evt_e2e${randomBytes(7).toString('hex')}`,
    },
  };
}

export function paymentIdOf(webhook: SignedWebhook): string {
  return (JSON.parse(webhook.body) as { payload: { payment: { entity: { id: string } } } }).payload.payment.entity.id;
}

export async function sendWebhook(anonymous: APIRequestContext, webhook: SignedWebhook, tenantKey = org): Promise<{ status: number; body: unknown }> {
  const res = await anonymous.post(`/webhooks/payments/razorpay/${encodeURIComponent(tenantKey)}`, { data: webhook.body, headers: webhook.headers });
  const text = await res.text();
  return { status: res.status(), body: text ? (JSON.parse(text) as unknown) : null };
}

/**
 * The integration fixture's TLS folder. The API trusts that fixture's CA through
 * NODE_EXTRA_CA_CERTS, so a receiver serving its server certificate is trusted too.
 */
export function fixtureTlsDir(): string {
  if (process.env.E2E_FIXTURE_TLS_DIR) return process.env.E2E_FIXTURE_TLS_DIR;
  const origin = process.env.INTEGRATION_FIXTURE_ORIGIN;
  const port = origin ? new URL(origin).port : '8095';
  return join(repoRoot, '.data', 'service-sandbox', port, 'tls');
}

export interface ReceivedWebhook {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  verified: boolean;
}

export interface WebhookReceiver {
  url: string;
  received: ReceivedWebhook[];
  close(): Promise<void>;
}

/** An https receiver on 127.0.0.1 that checks `x-ngo-signature: sha256=<hex HMAC of the body>` and answers 200 or 401. */
export async function startWebhookReceiver(tlsDir: string, signingSecret: string): Promise<WebhookReceiver> {
  const cert = readFileSync(join(tlsDir, 'server.crt'), 'utf8');
  const key = readFileSync(join(tlsDir, 'server.key'), 'utf8');
  const received: ReceivedWebhook[] = [];
  const server = createServer({ cert, key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const expected = `sha256=${createHmac('sha256', signingSecret).update(body).digest('hex')}`;
      const given = String(req.headers['x-ngo-signature'] ?? '');
      const verified = given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      received.push({ path: req.url ?? '', headers: req.headers, body, verified });
      res.writeHead(verified ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: verified }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/hooks/e2e`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function hasFixtureTls(dir: string): boolean {
  return existsSync(join(dir, 'server.crt')) && existsSync(join(dir, 'server.key'));
}
