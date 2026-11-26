import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ActionDef, FieldDef } from '../src/shared/definitions/types.js';
import { completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';

/**
 * Pay now asks which bank account the donor pays into. The UPI link goes to that account, and when the
 * payment arrives the donation's "Received in" is that account, so the books are posted to the right bank.
 */

let w: TestWorld;

beforeAll(async () => {
  w = await createWorld();
  const ctx = w.as(w.ngoA);
  await completeIdentity(w, w.ngoA);
  await w.platform.moneyAccounts.update(ctx, 'upi', { upiId: 'main@sbi' });
  await w.platform.moneyAccounts.open(ctx, { key: 'project', name: 'Project bank (HDFC)', kind: 'bank', upiId: 'project@hdfc' });
  await w.platform.moneyAccounts.open(ctx, { key: 'savings', name: 'Savings (no UPI)', kind: 'bank' });
}, 120_000);
afterAll(() => w.close());

const ctx = () => w.as(w.ngoA);
const balance = async (key: string) => Number((await w.platform.moneyAccounts.get(ctx(), key)).balance);
const raise = async (amount = 500) => (await w.platform.records.create(ctx(), 'donation', { donorName: 'Asha Verma', amount })).record;
const payNow = (id: string, input: Record<string, unknown> = {}) => w.platform.actions.run(ctx(), 'donation', id, 'payNow', { input });
const settle = async (paymentId: string) => {
  await w.platform.payments.confirmManually(ctx(), paymentId, { paidOn: today(), bankReference: 'UTR-' + paymentId.slice(0, 6) });
  await w.platform.dispatcher.runOnce();
};

describe('Pay now', () => {
  it('sends the link to the account chosen, and books the donation to it when paid', async () => {
    const before = { upi: await balance('upi'), project: await balance('project') };
    const d = await raise(500);
    const res = await payNow(d.id, { account: 'project' });
    expect(res.payment!.upiLink).toContain('pa=project%40hdfc');
    await settle(res.payment!.id);
    expect(await w.platform.records.get(ctx(), d.id)).toMatchObject({ status: 'paid', data: { method: 'upi', receivedIn: expect.stringMatching(/./) } });
    expect(await balance('project')).toBe(before.project + 500);
    expect(await balance('upi')).toBe(before.upi);
  });

  it('uses the main bank account when none is chosen', async () => {
    const before = { upi: await balance('upi'), project: await balance('project') };
    const d = await raise(300);
    const res = await payNow(d.id);
    expect(res.payment!.upiLink).toContain('pa=main%40sbi');
    await settle(res.payment!.id);
    expect(await balance('upi')).toBe(before.upi + 300);
    expect(await balance('project')).toBe(before.project);
  });

  it('keeps the chosen account on the payment request', async () => {
    const d = await raise(120);
    const res = await payNow(d.id, { account: 'project' });
    const [row] = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ account_key: string | null }>(`select account_key from payment_intent where id = $1`, [res.payment!.id]));
    expect(row!.account_key).toBe('project');
    await settle(res.payment!.id);
  });

  it('refuses an account that has no UPI ID, is unknown, or is not an account at all', async () => {
    const d = await raise(100);
    await expectCode(payNow(d.id, { account: 'savings' }), 'rule_violation');
    await expectCode(payNow(d.id, { account: 'nowhere' }), 'rule_violation');
    // Nothing was left waiting by the refused tries, so a good one still goes through.
    const ok = await payNow(d.id, { account: 'upi' });
    expect(ok.payment!.upiLink).toContain('pa=main%40sbi');
    await settle(ok.payment!.id);
  });

  it('pays into the chosen account when the payment is matched on the bank statement', async () => {
    const before = await balance('project');
    const d = await raise(777);
    const res = await payNow(d.id, { account: 'project' });
    const result = await w.platform.payments.matchStatement(ctx(), [{ date: today(), amount: 777, description: `UPI/CR/1/${res.payment!.upiLink!.match(/tr=(NGO[A-Z0-9]+)/)![1]}` }]);
    expect(result.matched).toEqual([res.payment!.id]);
    await w.platform.dispatcher.runOnce();
    expect((await w.platform.records.get(ctx(), d.id)).status).toBe('paid');
    expect(await balance('project')).toBe(before + 777);
  });

  it('still refuses an amount that is not the donation amount', async () => {
    const d = await raise(900);
    const err = await expectCode(w.platform.payments.createIntent(ctx(), { recordId: d.id, amount: 1, provider: 'upi_direct', onPaid: { transition: 'markPaid', fields: { paidOn: 'paidOn', reference: 'reference', method: 'method', account: 'receivedIn' }, methodValue: 'upi' }, upiAccountKey: 'project' }), 'rule_violation');
    expect(err.message).toMatch(/receipt would be for 900/);
  });
});

describe('the form Pay now shows', () => {
  it('lists the accounts that have a UPI ID, by key, and not the others', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const actor = { id: 'fin-1', roles: ['finance'], permissions: ['record:donation:read', 'record:donation:action:payNow', 'payments:create'] };
    const res = await app.inject({ method: 'GET', url: '/api/runtime/definitions', headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) } });
    await app.close();
    const actions = res.json().actions.donation as (ActionDef & { form?: { fields: FieldDef[] } })[];
    const field = actions.find((a) => a.key === 'payNow')!.form!.fields[0]!;
    expect(field).toMatchObject({ key: 'account', choicesFrom: 'upiAccounts' });
    expect(field.choices).toEqual([
      { value: 'upi', label: 'Main bank account' },
      { value: 'project', label: 'Project bank (HDFC)' },
    ]);
    // Step settings stay on the server.
    expect(JSON.stringify(res.json().actions)).not.toContain('accountFrom');
  });

  it('stops listing an account once it is closed', async () => {
    await w.platform.moneyAccounts.open(ctx(), { key: 'temp', name: 'Temporary', kind: 'bank', upiId: 'temp@bank' });
    await w.platform.moneyAccounts.close(ctx(), 'temp');
    const app = buildServer(w.platform, { devAuth: true });
    const actor = { id: 'fin-1', roles: ['finance'], permissions: ['record:donation:read', 'record:donation:action:payNow'] };
    const res = await app.inject({ method: 'GET', url: '/api/runtime/definitions', headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) } });
    await app.close();
    const actions = res.json().actions.donation as { key: string; form?: { fields: FieldDef[] } }[];
    expect(actions.find((a) => a.key === 'payNow')!.form!.fields[0]!.choices!.map((c) => c.value)).not.toContain('temp');
  });
});

describe('an action that lets the person choose the account', () => {
  const action = (over: Record<string, unknown> = {}, step: Record<string, unknown> = {}, field: Record<string, unknown> = {}) => ({
    key: 'payChoice',
    recordType: 'donation',
    label: 'Pay choice',
    placement: ['panel'],
    form: { fields: [{ key: 'account', label: 'Pay into', type: 'choice', choicesFrom: 'upiAccounts', ...field }] },
    steps: [
      { type: 'createPayment', provider: 'upi', amount: 'record.amount', accountFrom: 'input.account', onPaid: { transition: 'markPaid', fields: { paidOn: 'paidOn', reference: 'reference', method: 'method', account: 'receivedIn' }, methodValue: 'upi' }, ...step },
    ],
    ...over,
  });
  const publish = async (def: unknown) => {
    await w.platform.definitions.saveDraft(ctx(), 'action', def as never);
    await w.platform.definitions.publish(ctx(), 'action', (def as { key: string }).key);
  };

  it('needs an account, or a way to choose one', async () => {
    await expectCode(publish(action({ key: 'noAccount' }, { accountFrom: undefined })), 'definition_invalid');
    await expectCode(publish(action({ key: 'badExpr' }, { accountFrom: 'input.' })), 'definition_invalid');
  });

  it('needs choicesFrom to sit on a choice field, and not beside a list of choices', async () => {
    await expectCode(publish(action({ key: 'notChoice' }, {}, { type: 'text' })), 'definition_invalid');
    await expectCode(publish(action({ key: 'both' }, {}, { choices: [{ value: 'a', label: 'A' }] })), 'definition_invalid');
    await expectCode(publish(action({ key: 'nowhere' }, {}, { choicesFrom: 'somewhere' })), 'definition_invalid');
  });

  it('takes any account when the action has no fixed one', async () => {
    await publish(action({ key: 'payChoice' }, { account: 'upi' }));
    const before = await balance('project');
    const d = await raise(250);
    const res = await w.platform.actions.run(ctx(), 'donation', d.id, 'payChoice', { input: { account: 'project' } });
    expect(res.payment!.upiLink).toContain('pa=project%40hdfc');
    await settle(res.payment!.id);
    expect(await balance('project')).toBe(before + 250);
  });
});
