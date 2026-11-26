import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { FieldDef } from '../src/shared/definitions/types.js';
import { completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';

/**
 * Every form that names the real account the money moved through offers the organisation's own money
 * accounts, and the books are posted to the one chosen. Values stored before (BANK, CASH) still work.
 */

let w: TestWorld;
let second: string;

beforeAll(async () => {
  w = await createWorld();
  const ctx = w.as(w.ngoA);
  for (const key of ['expenses', 'earnings', 'members']) {
    await w.platform.definitions.enableModule(ctx, (await w.platform.publishShippedModule(key)).manifest);
  }
  await completeIdentity(w, w.ngoA);
  second = (await w.platform.moneyAccounts.open(ctx, { key: 'project', name: 'Project bank (HDFC)', kind: 'bank' })).ledgerCode;
}, 120_000);
afterAll(() => w.close());

const balance = async (key: string) => Number((await w.platform.moneyAccounts.get(w.as(w.ngoA), key)).balance);

describe('the forms', () => {
  const FIELDS = [
    ['expenseClaim', 'paidFrom'],
    ['earning', 'receivedIn'],
    ['membershipFee', 'paidTo'],
    ['donation', 'receivedIn'],
  ] as const;

  it('offer the money accounts, with the main bank and cash always there', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const actor = { id: 'viewer-1', roles: ['viewer'], permissions: ['record:donation:read', 'record:earning:read', 'record:expenseClaim:read', 'record:membershipFee:read'] };
    const res = await app.inject({ method: 'GET', url: '/api/runtime/definitions', headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) } });
    await app.close();
    const types = res.json().recordTypes as { key: string; fields: FieldDef[] }[];
    for (const [type, field] of FIELDS) {
      const f = types.find((t) => t.key === type)!.fields.find((x) => x.key === field)!;
      expect(f.choicesFrom, `${type}.${field}`).toBe('moneyAccounts');
      expect(f.choices!.map((c) => c.value)).toEqual(['BANK', second, 'CASH']);
    }
  });
});

describe('a donation', () => {
  const pay = async (data: Record<string, unknown>) => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Asha Verma', amount: 400 });
    return w.platform.records.transition(ctx, record.id, 'markPaid', { expectedVersion: record.version, data: { paidOn: today(), ...data } });
  };

  it('lands in the account chosen as Received in', async () => {
    const before = { upi: await balance('upi'), project: await balance('project') };
    await pay({ method: 'bank_transfer', receivedIn: second });
    expect(await balance('project')).toBe(before.project + 400);
    expect(await balance('upi')).toBe(before.upi);
  });

  it('lands in cash for a cash donation, and in the main bank otherwise, when no account is chosen', async () => {
    const before = { upi: await balance('upi'), cash: await balance('cash') };
    await pay({ method: 'cash' });
    await pay({ method: 'cheque' });
    expect(await balance('cash')).toBe(before.cash + 400);
    expect(await balance('upi')).toBe(before.upi + 400);
  });

  it('refuses an account that is not one of the organisation’s', async () => {
    await expectCode(pay({ method: 'cash', receivedIn: 'DONATION_INCOME' }), 'validation_failed');
  });

  it('does not ask for the account when marking paid', async () => {
    const workflow = (await w.platform.definitions.get(w.ngoA, 'workflow', 'donation'))!.body;
    expect(workflow.transitions.find((t) => t.key === 'markPaid')!.requiredFields).toEqual(['method', 'paidOn']);
  });
});

describe('an earning', () => {
  const receive = async (receivedIn: string) => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'earning', { title: 'Interest', category: 'interest', amount: 250 });
    return w.platform.records.transition(ctx, record.id, 'markReceived', { expectedVersion: record.version, data: { receivedIn, receivedOn: today() } });
  };

  it('lands in the second bank account', async () => {
    const before = await balance('project');
    await receive(second);
    expect(await balance('project')).toBe(before + 250);
  });

  it('still takes the older values BANK and CASH, and refuses anything else', async () => {
    const before = { upi: await balance('upi'), cash: await balance('cash') };
    await receive('BANK');
    await receive('CASH');
    expect(await balance('upi')).toBe(before.upi + 250);
    expect(await balance('cash')).toBe(before.cash + 250);
    await expectCode(receive('NOWHERE'), 'validation_failed');
  });
});

describe('a membership fee', () => {
  it('lands in the account chosen as Received in', async () => {
    const ctx = w.as(w.ngoA);
    const { userId } = await w.platform.people.add(ctx, { email: 'ravi.fee@example.org', displayName: 'Ravi Kumar', roles: [] });
    const member = await w.platform.records.create(ctx, 'member', { login: userId, phone: '+91 98765 43210' });
    const { record } = await w.platform.records.create(ctx, 'membershipFee', { member: member.record.id, amount: 600 });
    const before = await balance('project');
    await w.platform.records.transition(ctx, record.id, 'markPaid', { expectedVersion: record.version, data: { paidTo: second, method: 'bank_transfer', paidOn: today() } });
    expect(await balance('project')).toBe(before + 600);
  });
});
