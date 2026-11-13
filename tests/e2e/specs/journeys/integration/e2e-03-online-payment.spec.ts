import { expect, test, type APIRequestContext } from '@playwright/test';
import { accounts } from '../../../src/accounts.js';
import { anonymousApi, memberApi, runTag } from '../../../src/api.js';
import { signIn } from '../../../src/sign-in.js';
import {
  auditSince,
  createDonation,
  donation,
  donationStatus,
  ensureGatewayAction,
  ensureUpiAccount,
  gatewayActionKey,
  gatewayDonor,
  intent,
  paymentIdOf,
  razorpayWebhook,
  razorpayWebhookSecret,
  receipts,
  sendWebhook,
  uniqueAmount,
  utcToday,
  type Donation,
  type Intent,
  type SignedWebhook,
} from '../../../src/journeys/integration.js';

const waiting = 'This record already has a payment waiting.';
const payNow = 'Pay now';
const gatewayEnv =
  'The API must run with RAZORPAY_API_BASE set to the integration fixture (npm run dev does this); set E2E_RAZORPAY_WEBHOOK_SECRET when Razorpay is set up with other keys, and E2E_RAZORPAY_ACTION to use an existing published Razorpay action.';

test.describe.serial('FT-E2E-03 Online gateway payment', () => {
  const started = new Date();
  let finance: APIRequestContext;
  let admin: APIRequestContext;
  let anonymous: APIRequestContext;

  const upiAmount = uniqueAmount(1100);
  let upi: Donation;
  let upiBlocked: string | null = null;
  let upiIntent: Intent | undefined;
  const bankReference = runTag('UPI').toUpperCase();

  const gatewayAmount = uniqueAmount(1200);
  let gateway: Donation;
  let failing: Donation;
  let gatewayIntent: Intent | undefined;
  let failingIntent: Intent | undefined;
  let secret = '';
  let gatewayBlocked: string | null = null;
  let captured: SignedWebhook | undefined;

  test.beforeAll(async () => {
    finance = await memberApi(accounts.finance.email);
    admin = await memberApi(accounts.admin.email);
    anonymous = await anonymousApi();

    upiBlocked = await ensureUpiAccount(admin);
    upi = await createDonation(finance, { donorName: runTag('E2E UPI donor'), amount: upiAmount });

    const webhookSecret = await razorpayWebhookSecret(admin);
    if ('blocked' in webhookSecret) gatewayBlocked = webhookSecret.blocked;
    else secret = webhookSecret.secret;
    gatewayBlocked ??= await ensureGatewayAction(admin);

    gateway = await createDonation(finance, { donorName: gatewayDonor, amount: gatewayAmount, notes: runTag('captured') });
    failing = await createDonation(finance, { donorName: gatewayDonor, amount: uniqueAmount(1300), notes: runTag('failed') });
    if (gatewayBlocked) return;
    for (const record of [gateway, failing]) {
      const res = await finance.post('/api/payments', { data: { recordId: record.id, action: gatewayActionKey } });
      if (res.status() !== 201) {
        gatewayBlocked = `Creating the Razorpay order answered ${res.status()}: ${await res.text()}`;
        return;
      }
      const created = (await res.json()) as Intent;
      if (record === gateway) gatewayIntent = created;
      else failingIntent = created;
    }
    if (!gatewayIntent?.checkout?.orderId || !failingIntent?.checkout?.orderId) gatewayBlocked = 'The Razorpay payment request came back without an order id.';
  });

  test.afterAll(async () => {
    await Promise.all([finance?.dispose(), admin?.dispose(), anonymous?.dispose()]);
  });

  const skipGateway = () => test.skip(!!gatewayBlocked, `${gatewayBlocked ?? ''} ${gatewayEnv}`);

  test('FT-DON-053 Pay now on a Raised donation creates a UPI payment request and its UPI link', { tag: ['@e2e', '@FT-E2E-03', '@P1'] }, async ({ page }) => {
    test.skip(!!upiBlocked, upiBlocked ?? '');
    test.setTimeout(90_000);
    await signIn(page, accounts.finance.email, accounts.finance.name);
    await page.goto(`/records/donation?id=${upi.id}`);
    const answer = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/api/records/donation/${upi.id}/actions/payNow`));
    await page.getByRole('button', { name: payNow, exact: true }).click();
    const res = await answer;
    expect(res.status()).toBe(200);
    const out = (await res.json()) as { open?: string; payment?: Intent };
    upiIntent = out.payment;
    expect(upiIntent?.provider).toBe('upi_direct');
    expect(upiIntent?.status).toBe('awaiting_payment');
    expect(upiIntent?.reference).toMatch(/^NGO[A-Z0-9]{8}$/);
    const link = new URL(String(upiIntent?.upiLink));
    expect(link.protocol).toBe('upi:');
    expect(link.searchParams.get('am')).toBe(upiAmount.toFixed(2));
    expect(link.searchParams.get('cu')).toBe('INR');
    expect(link.searchParams.get('tr')).toBe(upiIntent?.reference);
    expect(out.open).toBe(upiIntent?.upiLink);
    expect(await donationStatus(finance, upi.id)).toBe('raised');
  });

  test('FT-DON-054 Pay now twice says a payment is waiting; the waiting UPI payment then confirms to Paid with its fields', { tag: ['@e2e', '@FT-E2E-03', '@P1'] }, async ({ page }) => {
    test.skip(!upiIntent, 'FT-DON-053 did not create the UPI payment request.');
    test.setTimeout(90_000);
    await signIn(page, accounts.finance.email, accounts.finance.name);
    await page.goto(`/records/donation?id=${upi.id}`);
    await page.getByRole('button', { name: payNow, exact: true }).click();
    await expect(page.getByText(waiting)).toBeVisible();
    expect(await donationStatus(finance, upi.id)).toBe('raised');
    expect((await intent(finance, upiIntent!.id)).status).toBe('awaiting_payment');

    const paidOn = utcToday();
    const confirm = await finance.post(`/api/payments/${upiIntent!.id}/confirm`, { data: { paidOn, bankReference } });
    expect(confirm.status()).toBe(204);
    await expect.poll(() => donationStatus(finance, upi.id), { timeout: 20_000 }).toBe('paid');
    const paid = await donation(finance, upi.id);
    expect(paid.data.method).toBe('upi');
    expect(paid.data.reference).toBe(bankReference);
    expect(paid.data.paidOn).toBe(paidOn);
  });

  test('FT-FIN-070 a forged signature or an unknown organisation key is refused and nothing changes', { tag: ['@e2e', '@FT-E2E-03', '@P0'] }, async () => {
    skipGateway();
    const genuine = razorpayWebhook(gatewayIntent!.checkout!.orderId!, Math.round(gatewayAmount * 100), 'captured', secret);
    const forged = { body: genuine.body, headers: { ...genuine.headers, 'x-razorpay-signature': '0'.repeat(64) } };
    expect(await sendWebhook(anonymous, forged)).toEqual({ status: 401, body: { ok: false } });
    expect(await sendWebhook(anonymous, genuine, `no-such-org-${Date.now().toString(36)}`)).toEqual({ status: 401, body: { ok: false } });
    expect(await donationStatus(finance, gateway.id)).toBe('raised');
    expect((await intent(finance, gatewayIntent!.id)).status).toBe('awaiting_payment');
    expect(await receipts(finance, gateway.id)).toHaveLength(0);
  });

  test('FT-FIN-071 a webhook with a different amount, or with no amount, does not pay and is audited', { tag: ['@e2e', '@FT-E2E-03', '@P0'] }, async () => {
    skipGateway();
    const orderId = gatewayIntent!.checkout!.orderId!;
    expect((await sendWebhook(anonymous, razorpayWebhook(orderId, 100, 'captured', secret))).status).toBe(200);
    expect((await sendWebhook(anonymous, razorpayWebhook(orderId, null, 'captured', secret))).status).toBe(200);
    expect(await donationStatus(finance, gateway.id)).toBe('raised');
    expect((await intent(finance, gatewayIntent!.id)).status).toBe('awaiting_payment');
    expect(await receipts(finance, gateway.id)).toHaveLength(0);
    await expect
      .poll(async () => (await auditSince(admin, started, (e) => e.action === 'payment.amount_mismatch' && e.entityId === gatewayIntent!.id)).length)
      .toBe(2);
  });

  test('FT-FIN-068 a captured webhook with a valid signature pays the donation: one receipt, one posting', { tag: ['@e2e', '@FT-E2E-03', '@P0'] }, async () => {
    skipGateway();
    captured = razorpayWebhook(gatewayIntent!.checkout!.orderId!, Math.round(gatewayAmount * 100), 'captured', secret);
    expect(await sendWebhook(anonymous, captured)).toEqual({ status: 200, body: { ok: true } });
    await expect.poll(() => donationStatus(finance, gateway.id), { timeout: 20_000 }).toBe('paid');
    expect((await intent(finance, gatewayIntent!.id)).status).toBe('paid');
    const paid = await donation(finance, gateway.id);
    expect(paid.data.paidOn).toBe(utcToday());
    expect(paid.data.reference).toBe(paymentIdOf(captured));
    if (!process.env.E2E_RAZORPAY_ACTION) expect(paid.data.method).toBe('online');
    const issued = await receipts(finance, gateway.id);
    expect(issued).toHaveLength(1);
    expect(Number(issued[0]!.amount)).toBe(gatewayAmount);
    expect(issued[0]!.number).toMatch(/^RCPT\//);
    await expect.poll(async () => (await postings(admin, started, gatewayAmount)).length).toBe(1);
  });

  test('FT-FIN-069 the same webhook again answers 200 and issues no second receipt or posting', { tag: ['@e2e', '@FT-E2E-03', '@P0', '@smoke'] }, async () => {
    skipGateway();
    test.skip(!captured, 'FT-FIN-068 did not send the captured webhook.');
    expect(await sendWebhook(anonymous, captured!)).toEqual({ status: 200, body: { ok: true } });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await donationStatus(finance, gateway.id)).toBe('paid');
    expect(await receipts(finance, gateway.id)).toHaveLength(1);
    expect(await postings(admin, started, gatewayAmount)).toHaveLength(1);
  });

  test('FT-FIN-072 payment.failed marks the request failed and the donation stays Raised', { tag: ['@e2e', '@FT-E2E-03', '@P1'] }, async () => {
    skipGateway();
    const failed = razorpayWebhook(failingIntent!.checkout!.orderId!, Math.round(Number(failing.data.amount) * 100), 'failed', secret);
    expect(await sendWebhook(anonymous, failed)).toEqual({ status: 200, body: { ok: true } });
    await expect.poll(async () => (await intent(finance, failingIntent!.id)).status).toBe('failed');
    expect(await donationStatus(finance, failing.id)).toBe('raised');
    expect(await receipts(finance, failing.id)).toHaveLength(0);
  });

  test('FT-E2E-03 the gateway donation was paid automatically once, and the duplicate webhook was ignored', { tag: ['@e2e', '@FT-E2E-03', '@P0'] }, async () => {
    skipGateway();
    expect(await donationStatus(finance, gateway.id)).toBe('paid');
    expect(await receipts(finance, gateway.id)).toHaveLength(1);
    expect(await postings(admin, started, gatewayAmount)).toHaveLength(1);
    const confirmed = await auditSince(admin, started, (e) => e.action === 'payment.confirmed' && e.entityId === gatewayIntent!.id);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.actorId).toBe('system:payments:razorpay');
    expect(await donationStatus(finance, failing.id)).toBe('raised');
  });
});

/** Donation postings since the journey started for this amount; the amount carries this run's paise. */
function postings(admin: APIRequestContext, since: Date, amount: number) {
  return auditSince(admin, since, (e) => e.action === 'journal.posted' && e.after?.source === 'donationPaid' && Number(e.after?.total) === amount);
}
