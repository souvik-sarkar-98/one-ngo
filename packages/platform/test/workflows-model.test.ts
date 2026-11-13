import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { DefinitionBodies, DefinitionKind, WorkflowDef } from '../src/runtime/definitions/types.js';
import { workflowsOf } from '../src/runtime/definitions/workflows.js';
import { admin, clerk, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
  await completeIdentity(w, w.ngoA);
});
afterAll(() => w.close());

async function publish<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<void> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, kind, body);
  await w.platform.definitions.publish(ctx, kind, body.key);
}

async function issues<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): Promise<string> {
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.saveDraft(ctx, kind, body);
  const err = await expectCode(w.platform.definitions.publish(ctx, kind, body.key), 'definition_invalid');
  await w.platform.definitions.discardDraft(ctx, kind, body.key);
  return (err as unknown as { issues: { path: string; message: string }[] }).issues.map((i) => `${i.path} ${i.message}`).join(' | ');
}

const closure: WorkflowDef = {
  key: 'donationReview',
  recordType: 'donation',
  role: 'parallel',
  startsWhen: 'record.amount >= 50000',
  initial: 'open',
  states: [
    { key: 'open', label: 'Open' },
    { key: 'reviewed', label: 'Reviewed', final: true },
  ],
  transitions: [{ key: 'review', label: 'Review', from: ['open'], to: 'reviewed' }],
};

describe('ordering', () => {
  it('puts the default primary first, then other primaries, then parallel workflows', () => {
    const ws: WorkflowDef[] = [
      { ...closure, key: 'z-parallel' },
      { ...closure, key: 'a-parallel' },
      { key: 'b-alt', recordType: 'donation', appliesWhen: 'true', initial: 'x', states: [], transitions: [] },
      { key: 'y-default', recordType: 'donation', initial: 'x', states: [], transitions: [] },
      { key: 'other', recordType: 'visit', initial: 'x', states: [], transitions: [] },
    ];
    expect(workflowsOf(ws, 'donation', (x) => x).map((x) => x.key)).toEqual(['y-default', 'b-alt', 'a-parallel', 'z-parallel']);
  });
});

describe('several workflows per record type', () => {
  it('publishes a parallel workflow and an alternative primary beside the shipped one', async () => {
    await publish('workflow', closure);
    await publish('workflow', {
      key: 'bigGift',
      recordType: 'donation',
      appliesWhen: "record.method == 'cheque'",
      initial: 'raised',
      states: [
        { key: 'raised', label: 'Raised' },
        { key: 'banked', label: 'Banked', final: true },
      ],
      transitions: [{ key: 'bank', label: 'Bank it', from: ['raised'], to: 'banked' }],
    });
    const all = await w.platform.definitions.workflowsFor(w.ngoA, 'donation');
    expect(all.map((x) => x.key)).toEqual(['donation', 'bigGift', 'donationReview']);
    expect((await w.platform.definitions.workflowFor(w.ngoA, 'donation'))!.key).toBe('donation');
  });

  it('keeps the runtime workflow of a record type as the default primary', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const res = await app.inject({
      method: 'GET',
      url: '/api/runtime/definitions',
      headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(clerk) },
    });
    expect(res.json().workflows.donation.key).toBe('donation');
    await app.close();
  });

  it('checks roles, conditions and step keys across the workflows', async () => {
    const messages = await issues('workflow', {
      key: 'clash',
      recordType: 'donation',
      appliesWhen: 'record.amount >',
      startsWhen: 'true',
      initial: 'raised',
      states: [{ key: 'raised', label: 'Raised' }],
      transitions: [
        { key: 'markPaid', label: 'Paid again', from: ['raised'], to: 'raised' },
        { key: 'review', label: 'Review again', from: ['raised'], to: 'raised' },
      ],
    });
    for (const m of [
      '/startsWhen primary workflows use appliesWhen, not startsWhen',
      '/appliesWhen expression error',
      "/transitions/0/key step 'markPaid' is already used by workflow 'donation'",
      "/transitions/1/key step 'review' is already used by workflow 'donationReview'",
    ]) {
      expect(messages).toContain(m);
    }
    expect(await issues('workflow', { ...closure, key: 'para2', appliesWhen: 'true', transitions: [] })).toContain(
      '/appliesWhen parallel workflows use startsWhen, not appliesWhen',
    );
    expect(await issues('workflow', { ...closure, key: 'second', role: 'primary', startsWhen: undefined, transitions: [] })).toContain(
      "/appliesWhen workflow 'donation' already applies to every record",
    );
  });

  it('resolves the workflow named by chips, rules and triggers', async () => {
    const messages = await issues('listView', {
      key: 'reviews',
      recordType: 'donation',
      chips: [
        { id: 'open', label: 'Open', workflowState: { workflow: 'donationReview', in: ['open', 'lost'] } },
        { id: 'ghost', label: 'Ghost', workflowState: { workflow: 'ghost', in: ['x'] } },
      ],
    });
    expect(messages).toContain("/chips/0/workflowState/in workflow 'donationReview' has no state 'lost'");
    expect(messages).toContain("/chips/1/workflowState/workflow record type 'donation' has no workflow 'ghost'");
    await publish('listView', {
      key: 'reviews',
      recordType: 'donation',
      chips: [{ id: 'open', label: 'Open', workflowState: { workflow: 'donationReview', in: ['open'] } }],
    });

    expect(
      await issues('automation', {
        key: 'reviewed',
        recordType: 'donation',
        trigger: { event: 'statusChanged', to: 'paid', workflow: 'donationReview' },
        actions: [{ type: 'transition', transition: 'bank' }],
      }),
    ).toContain("/trigger unknown status 'paid'");
    await publish('automation', {
      key: 'reviewed',
      recordType: 'donation',
      trigger: { event: 'statusChanged', to: 'reviewed', workflow: 'donationReview' },
      actions: [{ type: 'transition', transition: 'bank' }],
    });

    expect(
      await issues('receiptRule', {
        key: 'reviewReceipt',
        recordType: 'donation',
        workflow: 'ghost',
        whenStatus: 'reviewed',
        series: 'donation-receipt',
        amount: 'record.amount',
        date: 'today()',
      }),
    ).toContain("/workflow record type 'donation' has no workflow 'ghost'");
    expect(
      await issues('postingRule', {
        key: 'reviewPost',
        recordType: 'donation',
        workflow: 'donationReview',
        whenStatus: 'paid',
        date: 'today()',
        lines: [
          { side: 'debit', account: 'BANK', amount: 'record.amount' },
          { side: 'credit', account: 'DONATION_INCOME', amount: 'record.amount' },
        ],
      }),
    ).toContain("/whenStatus workflow 'donationReview' has no state 'paid'");
  });

  it('leaves the Donations module behaving as before', async () => {
    const ctx = w.as(w.ngoA, clerk);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Same as ever', amount: 120 });
    expect(record.status).toBe('raised');
    const paid = await w.platform.records.transition(ctx, record.id, 'markPaid', {
      expectedVersion: 1,
      data: { method: 'cash', paidOn: today() },
    });
    expect(paid.record.status).toBe('paid');
    expect(paid.receipts.map((r) => r.number)).toEqual([expect.stringMatching(/^RCPT/)]);
    await w.platform.definitions.enableModule(w.as(w.ngoB, admin), (await w.platform.publishShippedModule('donations')).manifest);
  });
});
