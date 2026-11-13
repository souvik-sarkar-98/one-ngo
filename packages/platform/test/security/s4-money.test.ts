import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/infrastructure/postgres/db.js';
import { asTx } from '../../src/infrastructure/postgres/tx.js';
import { createWorld, today, type TestWorld } from '../helpers.js';

/** Probe for S4-1 (docs/reports/s4-review-2026-10-26.md). Asserts the SAFE behaviour. */
let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
  await w.platform.moneyAccounts.open(w.as(w.ngoA), { key: 'main', name: 'SBI current', kind: 'bank', upiId: 'asha.trust@sbi' });
});
afterAll(() => w.close());

/** Can see donations and take payments, but cannot move a donation through its workflow or edit it. */
const collector: Actor = { id: 'collector-1', roles: ['collector'], permissions: ['record:donation:read', 'payments:create'] };
/** Confirms money that really arrived: here, one rupee. */
const accounts: Actor = { id: 'accounts-1', roles: ['accounts'], permissions: ['payments:confirm'] };

describe('S4-1 a payment request takes its amount and paid step from the definitions', () => {
  it('S4-1: a one-rupee payment requested by a read-only collector does not mark a 1,00,000 donation paid and receipted', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Large donor', amount: 100000 });
    let intentId: string;
    try {
      const intent = await w.platform.payments.createIntent(w.as(w.ngoA, collector), {
        recordId: record.id,
        amount: 1,
        provider: 'upi_direct',
        upiAccountKey: 'main',
        onPaid: { transition: 'markPaid', fields: { paidOn: 'paidOn', reference: 'reference', method: 'method' } },
      });
      intentId = intent.id;
    } catch {
      return; // Safe: the caller cannot choose the amount or the paid step.
    }
    await w.platform.payments.confirmManually(w.as(w.ngoA, accounts), intentId, { paidOn: today(), bankReference: 'UTR-1-RUPEE' });
    await w.platform.dispatcher.runOnce();

    const after = await w.platform.records.get(w.as(w.ngoA), record.id);
    const receipts = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), record.id));
    expect({ status: after.status, receipts: receipts.map((r) => String(r.amount)) }).toEqual({ status: 'raised', receipts: [] });
  });
});
