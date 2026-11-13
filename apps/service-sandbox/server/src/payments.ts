import { createHmac, randomBytes } from 'node:crypto';
import { CASHFREE, PATHS, RAZORPAY } from './constants.js';
import { basic, header, readForm, readJson, redirect, sendJson, type Handler } from './http.js';
import type { FixtureLog } from './log.js';

export type Provider = 'razorpay' | 'cashfree';
export type Outcome = 'captured' | 'failed';

export interface StoredOrder {
  provider: Provider;
  orderId: string;
  amountPaise: number;
  reference: string;
  createdAt: string;
  status: 'created' | Outcome;
}

export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

const id = (prefix: string) => `${prefix}${randomBytes(7).toString('hex')}`;

/** Razorpay's webhook: `X-Razorpay-Signature` is the hex HMAC-SHA256 of the raw body with the webhook secret. */
export function razorpayWebhook(order: Pick<StoredOrder, 'orderId' | 'amountPaise'>, outcome: Outcome, webhookSecret: string = RAZORPAY.webhookSecret): SignedWebhook {
  const paymentId = id('pay_demo');
  const body = JSON.stringify({
    entity: 'event',
    account_id: 'acc_demo',
    event: outcome === 'captured' ? 'payment.captured' : 'payment.failed',
    contains: ['payment'],
    payload: {
      payment: {
        entity: { id: paymentId, entity: 'payment', amount: order.amountPaise, currency: 'INR', status: outcome, order_id: order.orderId, method: 'upi' },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', webhookSecret).update(body).digest('hex'),
      'x-razorpay-event-id': id('evt_demo'),
    },
  };
}

/** Cashfree's webhook: `x-webhook-signature` is the base64 HMAC-SHA256 of timestamp + raw body with the client secret. */
export function cashfreeWebhook(
  order: Pick<StoredOrder, 'orderId' | 'amountPaise'>,
  outcome: Outcome,
  clientSecret: string = CASHFREE.clientSecret,
  now: number = Date.now(),
): SignedWebhook {
  const amount = order.amountPaise / 100;
  const body = JSON.stringify({
    type: outcome === 'captured' ? 'PAYMENT_SUCCESS_WEBHOOK' : 'PAYMENT_FAILED_WEBHOOK',
    event_time: new Date(now).toISOString(),
    data: {
      order: { order_id: order.orderId, order_amount: amount, order_currency: 'INR' },
      payment: {
        cf_payment_id: Number(String(now).slice(-9)) + randomBytes(2).readUInt16BE(0),
        payment_status: outcome === 'captured' ? 'SUCCESS' : 'FAILED',
        payment_amount: amount,
        payment_currency: 'INR',
        payment_time: new Date(now).toISOString(),
      },
    },
  });
  const timestamp = String(now);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': createHmac('sha256', clientSecret).update(timestamp + body).digest('base64'),
      'x-webhook-version': '2023-08-01',
    },
  };
}

export type WebhookPost = (url: string, webhook: SignedWebhook) => Promise<{ status: number; body: string }>;

const defaultPost: WebhookPost = async (url, webhook) => {
  const res = await fetch(url, { method: 'POST', headers: webhook.headers, body: webhook.body, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: (await res.text()).slice(0, 500) };
};

export interface Payments {
  orders(): StoredOrder[];
  routes: Handler;
}

/**
 * Stands in for Razorpay `POST /v1/orders` and Cashfree `POST /pg/orders` with the fixed demo keys, and posts a
 * correctly signed Capture or Fail webhook for a stored order to `{oneNgoBaseUrl}/webhooks/payments/{provider}/{org}`.
 */
export function payments(log: FixtureLog, options: { oneNgoBaseUrl: string; post?: WebhookPost }): Payments {
  const orders = new Map<string, StoredOrder>();
  const post = options.post ?? defaultPost;
  const base = options.oneNgoBaseUrl.replace(/\/+$/, '');

  const routes: Handler = async (req, res) => {
    if (req.method === 'POST' && req.url.pathname === PATHS.razorpayOrders) {
      const creds = basic(req);
      if (creds?.user !== RAZORPAY.keyId || creds.password !== RAZORPAY.keySecret) {
        log.add('payments', 'Razorpay order refused: wrong key id or secret');
        return sendJson(res, 401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
      }
      const body = (await readJson(req)) as { amount?: unknown; currency?: unknown; receipt?: unknown } | undefined;
      if (!body || !Number.isInteger(body.amount) || (body.amount as number) < 100 || body.currency !== 'INR') {
        return sendJson(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'amount must be at least 100 paise and currency INR' } });
      }
      const order: StoredOrder = { provider: 'razorpay', orderId: id('order_demo'), amountPaise: body.amount as number, reference: String(body.receipt ?? ''), createdAt: new Date().toISOString(), status: 'created' };
      orders.set(order.orderId, order);
      log.add('payments', `Razorpay order ${order.orderId} for ₹${(order.amountPaise / 100).toFixed(2)}`, order);
      return sendJson(res, 200, {
        id: order.orderId,
        entity: 'order',
        amount: order.amountPaise,
        amount_paid: 0,
        amount_due: order.amountPaise,
        currency: 'INR',
        receipt: order.reference,
        status: 'created',
        attempts: 0,
        created_at: Math.floor(Date.now() / 1000),
      });
    }

    if (req.method === 'POST' && req.url.pathname === PATHS.cashfreeOrders) {
      if (header(req, 'x-client-id') !== CASHFREE.clientId || header(req, 'x-client-secret') !== CASHFREE.clientSecret) {
        log.add('payments', 'Cashfree order refused: wrong client id or secret');
        return sendJson(res, 401, { message: 'authentication Failed', code: 'request_failed', type: 'authentication_error' });
      }
      if (!header(req, 'x-api-version')) return sendJson(res, 400, { message: 'x-api-version is missing', code: 'request_failed', type: 'invalid_request_error' });
      const body = (await readJson(req)) as { order_id?: unknown; order_amount?: unknown; order_currency?: unknown } | undefined;
      if (!body || typeof body.order_id !== 'string' || typeof body.order_amount !== 'number' || body.order_amount < 1 || body.order_currency !== 'INR') {
        return sendJson(res, 400, { message: 'order_id, order_amount (at least 1) and order_currency INR are required', code: 'request_failed', type: 'invalid_request_error' });
      }
      if (orders.has(body.order_id)) return sendJson(res, 409, { message: 'order with same id is already present', code: 'order_already_exists', type: 'invalid_request_error' });
      const order: StoredOrder = { provider: 'cashfree', orderId: body.order_id, amountPaise: Math.round(body.order_amount * 100), reference: body.order_id, createdAt: new Date().toISOString(), status: 'created' };
      orders.set(order.orderId, order);
      log.add('payments', `Cashfree order ${order.orderId} for ₹${body.order_amount.toFixed(2)}`, order);
      return sendJson(res, 200, {
        cf_order_id: String(Date.now()),
        order_id: order.orderId,
        entity: 'order',
        order_amount: body.order_amount,
        order_currency: 'INR',
        order_status: 'ACTIVE',
        payment_session_id: id('session_demo_'),
        created_at: order.createdAt,
      });
    }

    const action = /^\/orders\/(razorpay|cashfree)\/([^/]+)\/(capture|fail)$/.exec(req.url.pathname);
    if (req.method === 'POST' && action) {
      const order = orders.get(decodeURIComponent(action[2]!));
      if (!order || order.provider !== action[1]) return sendJson(res, 404, { error: 'No such order.' });
      const form = await readForm(req);
      const org = (form.get('org') ?? '').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(org)) return sendJson(res, 400, { error: 'Give the organisation code.' });
      const outcome: Outcome = action[3] === 'capture' ? 'captured' : 'failed';
      const webhook = order.provider === 'razorpay' ? razorpayWebhook(order, outcome) : cashfreeWebhook(order, outcome);
      const url = `${base}/webhooks/payments/${order.provider}/${encodeURIComponent(org)}`;
      try {
        const answer = await post(url, webhook);
        if (answer.status >= 200 && answer.status < 300) order.status = outcome;
        log.add('payments', `${outcome === 'captured' ? 'Capture' : 'Fail'} webhook for ${order.orderId}: one-ngo answered ${answer.status}`, { url, answer: answer.body });
      } catch (error) {
        log.add('payments', `${outcome === 'captured' ? 'Capture' : 'Fail'} webhook for ${order.orderId} could not reach one-ngo`, { url, error: String(error) });
      }
      return redirect(res, '/', 303);
    }
    return false;
  };

  return { orders: () => [...orders.values()].reverse(), routes };
}
