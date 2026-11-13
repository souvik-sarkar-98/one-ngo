import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CashfreeProvider, RazorpayProvider, type HttpPost } from '../../../../packages/platform/src/infrastructure/payments/providers.js';
import { CASHFREE, RAZORPAY } from '../src/constants.js';
import { cashfreeWebhook, razorpayWebhook, type SignedWebhook } from '../src/payments.js';
import type { Fixture } from '../src/server.js';
import { call, tempFixture } from './helpers.js';

const razorpayCreds = { keyId: RAZORPAY.keyId, keySecret: RAZORPAY.keySecret, webhookSecret: RAZORPAY.webhookSecret };
const cashfreeCreds = { keyId: CASHFREE.clientId, keySecret: CASHFREE.clientSecret, webhookSecret: '', environment: CASHFREE.environment };

describe('webhook signatures', () => {
  it('Razorpay: the provider accepts a captured and a failed webhook signed by the fixture, and refuses another secret', () => {
    const provider = new RazorpayProvider();
    const order = { orderId: 'order_demo1', amountPaise: 64000 };
    const paid = razorpayWebhook(order, 'captured');
    expect(provider.parseWebhook(paid.body, paid.headers, razorpayCreds)).toMatchObject({ kind: 'paid', orderId: 'order_demo1', amountPaise: 64000 });
    const failed = razorpayWebhook(order, 'failed');
    expect(provider.parseWebhook(failed.body, failed.headers, razorpayCreds)).toMatchObject({ kind: 'failed', orderId: 'order_demo1' });
    expect(provider.parseWebhook(paid.body, paid.headers, { ...razorpayCreds, webhookSecret: 'another-secret' })).toBeNull();
  });

  it('Cashfree: the provider accepts a success and a failed webhook signed by the fixture, and refuses another secret', () => {
    const provider = new CashfreeProvider();
    const order = { orderId: 'ref-1', amountPaise: 25050 };
    const paid = cashfreeWebhook(order, 'captured');
    expect(provider.parseWebhook(paid.body, paid.headers, cashfreeCreds)).toMatchObject({ kind: 'paid', orderId: 'ref-1', amountPaise: 25050 });
    const failed = cashfreeWebhook(order, 'failed');
    expect(provider.parseWebhook(failed.body, failed.headers, cashfreeCreds)).toMatchObject({ kind: 'failed', orderId: 'ref-1' });
    expect(provider.parseWebhook(paid.body, paid.headers, { ...cashfreeCreds, keySecret: 'another-secret' })).toBeNull();
  });
});

describe('orders through the product providers', () => {
  let fixture: Fixture;
  let cleanup: () => Promise<void>;
  const sent: { url: string; webhook: SignedWebhook }[] = [];

  const post: HttpPost = async (url, init) => {
    const res = await call(fixture, url, { method: 'POST', headers: init.headers, body: init.body });
    return { status: res.status, json: async () => res.json() };
  };

  beforeAll(async () => {
    ({ fixture, cleanup } = await tempFixture({
      oneNgoBaseUrl: 'http://localhost:8080/',
      webhookPost: async (url, webhook) => {
        sent.push({ url, webhook });
        return { status: 200, body: '{"ok":true}' };
      },
    }));
  });
  afterAll(() => cleanup());

  it('Razorpay: creates an order with the demo keys, refuses others, and Capture posts a webhook the provider accepts', async () => {
    const provider = new RazorpayProvider(post, fixture.origin);
    const created = await provider.createOrder({ amountPaise: 64000, reference: 'donation-1' } as never, razorpayCreds);
    expect(created.orderId).toMatch(/^order_demo/);
    await expect(provider.createOrder({ amountPaise: 64000, reference: 'donation-1' } as never, { ...razorpayCreds, keySecret: 'wrong' })).rejects.toThrow(/Authentication failed/);

    const capture = await call(fixture, `/orders/razorpay/${created.orderId}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'org=asha',
    });
    expect(capture.status).toBe(303);
    const last = sent.at(-1)!;
    expect(last.url).toBe('http://localhost:8080/webhooks/payments/razorpay/asha');
    expect(provider.parseWebhook(last.webhook.body, last.webhook.headers, razorpayCreds)).toMatchObject({ kind: 'paid', orderId: created.orderId, amountPaise: 64000 });
    expect(fixture.payments.orders().find((o) => o.orderId === created.orderId)?.status).toBe('captured');
  });

  it('Cashfree: creates an order in either environment, and Fail posts a webhook the provider accepts', async () => {
    const provider = new CashfreeProvider(post, Date.now, { sandbox: fixture.origin, production: fixture.origin });
    const created = await provider.createOrder({ amountPaise: 25000, reference: 'donation-2', customer: { name: 'Asha', email: 'a@example.org' } } as never, cashfreeCreds);
    expect(created).toMatchObject({ orderId: 'donation-2', checkout: { provider: 'cashfree', mode: 'sandbox' } });
    await provider.createOrder({ amountPaise: 1000, reference: 'donation-3' } as never, { ...cashfreeCreds, environment: 'production' });

    const fail = await call(fixture, '/orders/cashfree/donation-2/fail', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'org=asha' });
    expect(fail.status).toBe(303);
    const last = sent.at(-1)!;
    expect(last.url).toBe('http://localhost:8080/webhooks/payments/cashfree/asha');
    expect(provider.parseWebhook(last.webhook.body, last.webhook.headers, cashfreeCreds)).toMatchObject({ kind: 'failed', orderId: 'donation-2', amountPaise: 25000 });
  });

  it('shows the orders on the log page', async () => {
    const page = await call(fixture, '/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('donation-2');
    expect(page.text).toContain(`RAZORPAY_API_BASE=${fixture.origin}`);
  });
});
