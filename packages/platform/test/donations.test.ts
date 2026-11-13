import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { clerk, completeIdentity, createWorld, currentFiscalYear, expectCode, today, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
  await completeIdentity(w, w.ngoA);
});
afterAll(() => w.close());

const viewer: Actor = { id: 'viewer-1', roles: ['viewer'], permissions: ['record:donation:read'] };
const treasurer: Actor = { id: 'treasurer-1', roles: ['treasurer'], permissions: ['record:*:*', 'record:donation:transition:*'] };

describe('donations module, end to end', () => {
  it('raises a donation with a number, calculated net amount, and initial status', async () => {
    const { record, receipts, journalEntryIds } = await w.platform.records.create(w.as(w.ngoA, clerk), 'donation', {
      donorName: '  Priya Sen ',
      amount: 2500,
      fee: 50,
    });
    expect(record).toMatchObject({
      status: 'raised',
      version: 1,
      number: `DON/${currentFiscalYear()}/00001`,
      data: { donorName: 'Priya Sen', amount: 2500, fee: 50, netAmount: 2450 },
    });
    expect(receipts).toHaveLength(0);
    expect(journalEntryIds).toHaveLength(0);
  });

  it('marks a donation paid: posts to the books and issues a receipt in the same transaction', async () => {
    const ctx = w.as(w.ngoA, clerk);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Arun', amount: 1000 });

    await expectCode(
      w.platform.records.transition(ctx, record.id, 'markPaid', { expectedVersion: 1 }),
      'validation_failed',
    );
    await expectCode(
      w.platform.records.transition(ctx, record.id, 'markPaid', {
        expectedVersion: 1,
        data: { method: 'upi', paidOn: today() },
      }),
      'validation_failed',
    );

    const paid = await w.platform.records.transition(ctx, record.id, 'markPaid', {
      expectedVersion: 1,
      data: { method: 'upi', paidOn: today(), reference: 'UPI-123' },
    });
    expect(paid.record).toMatchObject({ status: 'paid', version: 2 });
    expect(paid.receipts).toHaveLength(1);
    expect(paid.receipts[0]).toMatchObject({ amount: '1000.00', recordId: record.id, status: 'issued' });
    expect(paid.journalEntryIds).toHaveLength(1);

    const tb = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.ledger.trialBalance(asTx(tx), currentFiscalYear()));
    expect(tb.find((r) => r.code === 'BANK')?.debit).toBe('1000.00');
    expect(tb.find((r) => r.code === 'DONATION_INCOME')?.credit).toBe('1000.00');

    await expectCode(w.platform.records.update(ctx, record.id, { expectedVersion: 2, data: { amount: 1 } }), 'rule_violation');
    await expectCode(w.platform.records.transition(ctx, record.id, 'cancel', { expectedVersion: 2 }), 'rule_violation');
  });

  it('rolls the whole save back when posting fails', async () => {
    const ctx = w.as(w.ngoB, clerk);
    await w.platform.db.withTenant(w.ngoB, (tx) => w.platform.ledger.closePeriod(asTx(tx), { ...clerk }, currentFiscalYear()));
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Closed year', amount: 10 });
    await expectCode(
      w.platform.records.transition(ctx, record.id, 'markPaid', {
        expectedVersion: 1,
        data: { method: 'cash', paidOn: today() },
      }),
      'rule_violation',
    );
    const after = await w.platform.records.get(ctx, record.id);
    expect(after).toMatchObject({ status: 'raised', version: 1 });
    const receipts = await w.platform.db.withTenant(w.ngoB, (tx) => tx.query(`select 1 from receipt`));
    expect(receipts).toHaveLength(0);
  });

  it('names the donor a donation points at, on the record and in the list, keeping the stored id', async () => {
    const ctx = w.as(w.ngoA, treasurer);
    const donor = await w.platform.records.create(ctx, 'donor', { name: 'Nadia Rao' });
    const linked = { donor: { id: donor.record.id, label: 'Nadia Rao' } };
    const { record } = await w.platform.records.create(ctx, 'donation', { donor: donor.record.id, amount: 300 });
    expect(record.data.donor).toBe(donor.record.id);
    expect(record.references).toEqual(linked);
    expect((await w.platform.records.get(ctx, record.id)).references).toEqual(linked);
    const { items } = await w.platform.records.query(ctx, 'donation', { equals: { donor: donor.record.id } });
    expect(items.map((r) => r.references)).toEqual([linked]);
    expect((await w.platform.records.get(w.as(w.ngoA, viewer), record.id)).references).toEqual({});
  });

  it('detects concurrent edits', async () => {
    const ctx = w.as(w.ngoA, clerk);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Two tabs', amount: 10 });
    await w.platform.records.update(ctx, record.id, { expectedVersion: 1, data: { notes: 'first' } });
    await expectCode(w.platform.records.update(ctx, record.id, { expectedVersion: 1, data: { notes: 'second' } }), 'conflict');
  });

  it('enforces validation, rules, permissions, and calculated fields', async () => {
    const ctx = w.as(w.ngoA, clerk);
    await expectCode(w.platform.records.create(ctx, 'donation', { amount: 10 }), 'validation_failed');
    await expectCode(w.platform.records.create(ctx, 'donation', { donorName: 'X', amount: 10.005 }), 'validation_failed');
    await expectCode(w.platform.records.create(ctx, 'donation', { donorName: 'X', amount: 10, fee: 11 }), 'validation_failed');
    await expectCode(w.platform.records.create(ctx, 'donation', { donorName: 'X', amount: 10, colour: 'red' }), 'validation_failed');
    await expectCode(w.platform.records.create(ctx, 'donation', { donorName: 'X', amount: 10, netAmount: 1 }), 'validation_failed');
    await expectCode(w.platform.records.create(w.as(w.ngoA, viewer), 'donation', { donorName: 'X', amount: 10 }), 'forbidden');
  });

  it('masks sensitive fields unless the viewer has permission', async () => {
    const { record } = await w.platform.records.create(w.as(w.ngoA, treasurer), 'donation', {
      donorName: 'Sensitive',
      amount: 10,
      donorPan: 'ABCDE1234F',
    });
    expect(record.data.donorPan).toBe('ABCDE1234F');
    expect((await w.platform.records.get(w.as(w.ngoA, viewer), record.id)).data.donorPan).toBe('***');

    const audit = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ after: { data: Record<string, unknown> } }>(`select after from audit_event where entity_id = $1`, [record.id]),
    );
    expect(audit[0]!.after.data.donorPan).toBe('***');
  });
});

describe('override scripts on the donations module', () => {
  it('runs a published script before save, and cannot override calculated fields or the core rules', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'script', {
      key: 'donationTidy',
      recordType: 'donation',
      hook: 'beforeSave',
      code: `
        ctx.record.donorName = ctx.record.donorName.toUpperCase();
        ctx.record.netAmount = 999999;
        if (ctx.record.amount > 100000) ctx.fail('Donations above 1 lakh need the treasurer.');
      `,
    });
    await w.platform.definitions.publish(ctx, 'script', 'donationTidy');

    const { record } = await w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'meena', amount: 300 });
    expect(record.data).toMatchObject({ donorName: 'MEENA', netAmount: 300 });

    const err = await expectCode(
      w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'big', amount: 200000 }),
      'script_failed',
    );
    expect(err.message).toBe('Donations above 1 lakh need the treasurer.');

    const runs = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ outcome: string }>(`select outcome from script_run where script_key = 'donationTidy' order by id`),
    );
    expect(runs.map((r) => r.outcome)).toEqual(['ok', 'failed']);
  });

  it('cannot add unknown fields, and a script that loops forever is stopped', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'script', {
      key: 'donationTidy',
      recordType: 'donation',
      hook: 'beforeSave',
      code: `ctx.record.status = 'paid';`,
    });
    await w.platform.definitions.publish(ctx, 'script', 'donationTidy');
    await expectCode(w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'x', amount: 1 }), 'script_failed');

    await w.platform.definitions.saveDraft(ctx, 'script', {
      key: 'donationTidy',
      recordType: 'donation',
      hook: 'beforeSave',
      timeoutMs: 50,
      code: `for (;;) {}`,
    });
    await w.platform.definitions.publish(ctx, 'script', 'donationTidy');
    await expectCode(w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'x', amount: 1 }), 'script_limit');

    await w.platform.definitions.saveDraft(ctx, 'script', {
      key: 'donationTidy',
      recordType: 'donation',
      hook: 'beforeSave',
      enabled: false,
      code: `for (;;) {}`,
    });
    await w.platform.definitions.publish(ctx, 'script', 'donationTidy');
    await w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'x', amount: 1 });
  });

  it('requires the script-author permission to publish scripts', async () => {
    const configurator: Actor = { id: 'cfg', roles: ['config'], permissions: ['config:publish'] };
    await expectCode(
      w.platform.definitions.saveDraft(w.as(w.ngoA, configurator), 'script', {
        key: 'x',
        recordType: 'donation',
        hook: 'beforeSave',
        code: '1',
      }),
      'forbidden',
    );
  });
});
