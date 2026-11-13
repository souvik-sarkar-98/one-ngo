import { afterEach, describe, expect, it, vi } from 'vitest';
import { paymentProvidersFromEnvironment } from '../src/composition/entry.js';
import { CashfreeProvider, RazorpayProvider, type HttpPost, type PaymentProvider } from '../src/infrastructure/payments/providers.js';

const RAZORPAY = { keyId: 'rzp_test_hosts', keySecret: 'secret', webhookSecret: 'hook' };
const CASHFREE = { keyId: 'cf_hosts', keySecret: 'secret', webhookSecret: '' };
const ORDER = { amountPaise: 5000, reference: 'ref-hosts-1' } as never;

function recorder() {
  const urls: string[] = [];
  const post: HttpPost = async (url, init) => {
    urls.push(url);
    const body = url.includes('/v1/orders') ? { id: 'order_hosts' } : { order_id: JSON.parse(init.body).order_id, payment_session_id: 's' };
    return { status: 200, json: async () => body };
  };
  return { urls, post };
}

describe('payment provider hosts', () => {
  it('Razorpay posts to api.razorpay.com unless a base is given', async () => {
    const real = recorder();
    await new RazorpayProvider(real.post).createOrder(ORDER, RAZORPAY);
    expect(real.urls).toEqual(['https://api.razorpay.com/v1/orders']);

    const local = recorder();
    await new RazorpayProvider(local.post, 'https://127.0.0.1:8095/').createOrder(ORDER, RAZORPAY);
    expect(local.urls).toEqual(['https://127.0.0.1:8095/v1/orders']);
  });

  it('Cashfree posts to its sandbox and production hosts unless hosts are given', async () => {
    const real = recorder();
    const provider = new CashfreeProvider(real.post);
    await provider.createOrder(ORDER, { ...CASHFREE, environment: 'sandbox' });
    await provider.createOrder(ORDER, { ...CASHFREE, environment: 'production' });
    expect(real.urls).toEqual(['https://sandbox.cashfree.com/pg/orders', 'https://api.cashfree.com/pg/orders']);

    const local = recorder();
    const overridden = new CashfreeProvider(local.post, Date.now, { sandbox: 'https://127.0.0.1:8095', production: 'https://127.0.0.1:8095/' });
    await overridden.createOrder(ORDER, { ...CASHFREE, environment: 'sandbox' });
    await overridden.createOrder(ORDER, { ...CASHFREE, environment: 'production' });
    expect(local.urls).toEqual(['https://127.0.0.1:8095/pg/orders', 'https://127.0.0.1:8095/pg/orders']);
  });
});

describe('paymentProvidersFromEnvironment', () => {
  afterEach(() => vi.restoreAllMocks());

  async function postedUrls(providers: PaymentProvider[]): Promise<string[]> {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes('/v1/orders') ? { id: 'order_env' } : { order_id: JSON.parse(String(init?.body)).order_id, payment_session_id: 's' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const [razorpay, cashfree] = providers;
    await razorpay!.createOrder(ORDER, RAZORPAY);
    await cashfree!.createOrder(ORDER, { ...CASHFREE, environment: 'sandbox' });
    await cashfree!.createOrder(ORDER, { ...CASHFREE, environment: 'production' });
    return urls;
  }

  it('keeps the real hosts when nothing is set', async () => {
    expect(await postedUrls(paymentProvidersFromEnvironment({ RAZORPAY_API_BASE: '', CASHFREE_API_BASE: '  ' }))).toEqual([
      'https://api.razorpay.com/v1/orders',
      'https://sandbox.cashfree.com/pg/orders',
      'https://api.cashfree.com/pg/orders',
    ]);
  });

  it('sends Razorpay and both Cashfree environments to the set bases', async () => {
    const env = { RAZORPAY_API_BASE: 'https://127.0.0.1:8095', CASHFREE_API_BASE: 'https://127.0.0.1:8095/' };
    expect(await postedUrls(paymentProvidersFromEnvironment(env))).toEqual([
      'https://127.0.0.1:8095/v1/orders',
      'https://127.0.0.1:8095/pg/orders',
      'https://127.0.0.1:8095/pg/orders',
    ]);
  });

  it('refuses a base that is not an https address', () => {
    expect(() => paymentProvidersFromEnvironment({ RAZORPAY_API_BASE: 'http://127.0.0.1:8095' })).toThrow(/https/);
    expect(() => paymentProvidersFromEnvironment({ CASHFREE_API_BASE: 'not a url' })).toThrow(/CASHFREE_API_BASE/);
  });
});
