import { createHash } from 'node:crypto';
import { hmacSha256, safeEqual } from '@onengo/kernel/crypto';

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

import type { CreateOrderInput, CreatedOrder, PaymentProvider, PaymentWebhookEvent, ProviderCredentials } from '../../domain/payments/ports/payment-provider.js';

export type { CreateOrderInput, CreatedOrder, PaymentProvider, PaymentWebhookEvent, ProviderCredentials } from '../../domain/payments/ports/payment-provider.js';

export type HttpPost = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultPost: HttpPost = async (url, init) => {
  const res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body });
  return { status: res.status, json: () => res.json() };
};

export const RAZORPAY_API_BASE = 'https://api.razorpay.com';

/** Where Cashfree orders go for each saved environment. */
export interface CashfreeHosts {
  sandbox: string;
  production: string;
}
export const CASHFREE_HOSTS: CashfreeHosts = { sandbox: 'https://sandbox.cashfree.com', production: 'https://api.cashfree.com' };

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Razorpay Orders API and webhook (`X-Razorpay-Signature` = HMAC-SHA256 of the raw body).
 * Field names follow Razorpay's published API; verify against their sandbox before launch.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  private readonly apiBase: string;
  constructor(
    private readonly post: HttpPost = defaultPost,
    apiBase: string = RAZORPAY_API_BASE,
  ) {
    this.apiBase = withoutTrailingSlash(apiBase);
  }

  async createOrder(input: CreateOrderInput, creds: ProviderCredentials): Promise<CreatedOrder> {
    const res = await this.post(`${this.apiBase}/v1/orders`, {
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ amount: input.amountPaise, currency: 'INR', receipt: input.reference.slice(0, 40) }),
    });
    const body = (await res.json()) as { id?: string; error?: { description?: string } };
    if (res.status >= 300 || !body.id) throw new Error(`Razorpay order failed: ${body.error?.description ?? res.status}`);
    return { orderId: body.id, checkout: { provider: 'razorpay', key: creds.keyId, orderId: body.id, amount: input.amountPaise, currency: 'INR' } };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | undefined>, creds: ProviderCredentials): PaymentWebhookEvent | null {
    const signature = headers['x-razorpay-signature'];
    if (!signature || !safeEqual(signature, hmacSha256(creds.webhookSecret, rawBody))) return null;
    const body = JSON.parse(rawBody) as {
      event?: string;
      payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number } } };
    };
    const payment = body.payload?.payment?.entity;
    // The x-razorpay-event-id header is not signed; a replayed body must dedupe to the same id.
    const eventId = `${body.event}:${payment?.id ?? sha256Hex(rawBody)}`;
    const kind = body.event === 'payment.captured' ? 'paid' : body.event === 'payment.failed' ? 'failed' : 'ignored';
    return { eventId, kind, orderId: payment?.order_id ?? null, paymentId: payment?.id ?? null, amountPaise: payment?.amount ?? null };
  }
}

/** How far a signed Cashfree webhook timestamp may be from now, either way: five minutes. */
export const CASHFREE_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Cashfree sends epoch milliseconds; epoch seconds are accepted too. */
function timestampMs(value: string): number | null {
  if (!/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Cashfree PG Orders API and webhook (`x-webhook-signature` = base64 HMAC-SHA256 of timestamp + raw body).
 * The signed `x-webhook-timestamp` must be within CASHFREE_WEBHOOK_TOLERANCE_MS of now, so a captured webhook cannot be replayed later.
 * Field names follow Cashfree's published API; verify against their sandbox before launch.
 */
export class CashfreeProvider implements PaymentProvider {
  readonly name = 'cashfree' as const;
  private readonly hosts: CashfreeHosts;
  constructor(
    private readonly post: HttpPost = defaultPost,
    private readonly now: () => number = Date.now,
    hosts: CashfreeHosts = CASHFREE_HOSTS,
  ) {
    this.hosts = { sandbox: withoutTrailingSlash(hosts.sandbox), production: withoutTrailingSlash(hosts.production) };
  }

  async createOrder(input: CreateOrderInput, creds: ProviderCredentials): Promise<CreatedOrder> {
    const host = creds.environment === 'production' ? this.hosts.production : this.hosts.sandbox;
    const res = await this.post(`${host}/pg/orders`, {
      headers: {
        'content-type': 'application/json',
        'x-client-id': creds.keyId,
        'x-client-secret': creds.keySecret,
        'x-api-version': '2023-08-01',
      },
      body: JSON.stringify({
        order_id: input.reference,
        order_amount: input.amountPaise / 100,
        order_currency: 'INR',
        customer_details: {
          customer_id: input.reference,
          customer_name: input.customer?.name,
          customer_email: input.customer?.email,
          customer_phone: input.customer?.phone ?? '9999999999',
        },
      }),
    });
    const body = (await res.json()) as { order_id?: string; payment_session_id?: string; message?: string };
    if (res.status >= 300 || !body.order_id) throw new Error(`Cashfree order failed: ${body.message ?? res.status}`);
    return {
      orderId: body.order_id,
      checkout: { provider: 'cashfree', paymentSessionId: body.payment_session_id, mode: creds.environment ?? 'sandbox' },
    };
  }

  parseWebhook(rawBody: string, headers: Record<string, string | undefined>, creds: ProviderCredentials): PaymentWebhookEvent | null {
    const signature = headers['x-webhook-signature'];
    const timestamp = headers['x-webhook-timestamp'];
    if (!signature || !timestamp) return null;
    if (!safeEqual(signature, hmacSha256(creds.keySecret, timestamp + rawBody, 'base64'))) return null;
    const sentAt = timestampMs(timestamp);
    if (sentAt === null || Math.abs(this.now() - sentAt) > CASHFREE_WEBHOOK_TOLERANCE_MS) return null;
    const body = JSON.parse(rawBody) as {
      type?: string;
      data?: { order?: { order_id?: string; order_amount?: number }; payment?: { cf_payment_id?: string | number; payment_status?: string; payment_amount?: number } };
    };
    const status = body.data?.payment?.payment_status;
    const paymentId = body.data?.payment?.cf_payment_id;
    const amount = body.data?.payment?.payment_amount ?? body.data?.order?.order_amount;
    return {
      eventId: `${body.type}:${paymentId ?? body.data?.order?.order_id}`,
      kind: status === 'SUCCESS' ? 'paid' : status === 'FAILED' ? 'failed' : 'ignored',
      orderId: body.data?.order?.order_id ?? null,
      paymentId: paymentId === undefined ? null : String(paymentId),
      amountPaise: typeof amount === 'number' ? Math.round(amount * 100) : null,
    };
  }
}
