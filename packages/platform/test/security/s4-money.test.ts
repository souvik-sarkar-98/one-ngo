import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/infrastructure/postgres/db.js';
import { asTx } from '../../src/infrastructure/postgres/tx.js';
import { createWorld, expectCode, today, type TestWorld } from '../helpers.js';

/** Probes for S4-1, a payment request taking the caller's amount, against the shipped Pay now action. They assert the SAFE behaviour. */
let w: TestWorld;
const onPaid = { transition: 'markPaid', fields: { paidOn: 'paidOn', reference: 'reference', method: 'method' }, methodValue: 'upi' };

beforeAll(async () => {
  w = await createWorld();
  await w.platform.moneyAccounts.update(w.as(w.ngoA), 'upi', { upiId: 'asha.trust@sbi' });
});
afterAll(() => w.close());

/** May run the Pay now action and take payments, but cannot move a donation through its workflow or edit it. */
const collector: Actor = { id: 'collector-1', roles: ['collector'], permissions: ['record:donation:read', 'record:donation:action:payNow', 'payments:create'] };
/** Confirms money that really arrived: here, one rupee. */
const accounts: Actor = { id: 'accounts-1', roles: ['accounts'], permissions: ['payments:confirm'] };

describe('S4-1 a payment request takes its amount and paid step from the definitions', () => {
  it('S4-1: a one-rupee payment requested by a read-only collector is refused, so a 1,00,000 donation is not marked paid and receipted', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Large donor', amount: 100000 });
    const err = await expectCode(
      w.platform.payments.createIntent(w.as(w.ngoA, collector), { recordId: record.id, amount: 1, provider: 'upi_direct', upiAccountKey: 'upi', onPaid }),
      'rule_violation',
    );
    expect(err.message).toMatch(/receipt would be for 100000.00|payment action charges 100000.00/);
    const after = await w.platform.records.get(w.as(w.ngoA), record.id);
    const receipts = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), record.id));
    expect({ status: after.status, receipts: receipts.map((r) => String(r.amount)) }).toEqual({ status: 'raised', receipts: [] });
  });

  it('S4-1: an intent for the full amount that the record later outgrows is not confirmed for the old amount', async () => {
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Grown donor', amount: 100 });
    const intent = await w.platform.payments.createIntent(ctx, { recordId: record.id, amount: 100, provider: 'upi_direct', upiAccountKey: 'upi', onPaid });
    await w.platform.records.update(ctx, record.id, { data: { amount: 100000 }, expectedVersion: record.version });
    await expectCode(w.platform.payments.confirmManually(w.as(w.ngoA, accounts), intent.id, { paidOn: today(), bankReference: 'UTR-100' }), 'rule_violation');
    expect((await w.platform.payments.get(ctx, intent.id)).status).toBe('awaiting_payment');
  });
});
