import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../../packages/platform/src/infrastructure/postgres/db.js';
import { asTx } from '../../../packages/platform/src/infrastructure/postgres/tx.js';
import { admin, createWorld, expectCode, today, type TestWorld } from '../../support/platform/helpers.js';

/** Expense claims: Approve and Pay need a second person, and the books are written only after that person approves. */

let w: TestWorld;
let claimant: Actor;
let ann: Actor;
let bob: Actor;

function png(padding = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4), Buffer.alloc(padding, 7)]);
}

const CLAIMANT_PERMISSIONS = ['record:expenseClaim:create', 'record:expenseClaim:read', 'record:expenseClaim:update', 'record:expenseClaim:transition:submit'];
const APPROVER_PERMISSIONS = ['record:expenseClaim:*', 'record:expenseClaim:transition:*', 'money:accounts:read'];

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  const ctx = w.as(w.ngoA);
  await w.platform.definitions.enableModule(ctx, (await w.platform.publishShippedModule('expenses')).manifest);
  const member = (name: string, roles: string[]) =>
    w.platform.identity.addMember(ctx, { email: `${name.toLowerCase()}@example.org`, displayName: name, roles });
  claimant = { id: await member('Chitra', ['expense-claimant']), roles: ['expense-claimant'], permissions: CLAIMANT_PERMISSIONS };
  ann = { id: await member('Ann', ['expense-approver']), roles: ['expense-approver'], permissions: APPROVER_PERMISSIONS };
  bob = { id: await member('Bob', ['expense-approver']), roles: ['expense-approver'], permissions: APPROVER_PERMISSIONS };
  // The bank holds 2000, so a claim of 1200 can be paid and a second one cannot.
  await w.platform.db.withTenant(w.ngoA, (tx) =>
    w.platform.ledger.post(asTx(tx), admin, {
      date: today(),
      memo: 'Opening money',
      lines: [{ accountCode: 'BANK', debit: 2000 }, { accountCode: 'DONATION_INCOME', credit: 2000 }],
    }),
  );
});
afterAll(() => w.close());

const as = (who: Actor) => w.as(w.ngoA, who);

async function submittedClaim(): Promise<string> {
  const bill = await w.platform.files.upload(as(claimant), { body: [png(10)], name: 'bill.png', recordType: 'expenseClaim', field: 'billFile' });
  const { record } = await w.platform.records.create(as(claimant), 'expenseClaim', {
    title: 'Field visit travel',
    category: 'travel',
    amount: 1200,
    claimedOn: today(),
    billFile: bill.id,
  });
  await w.platform.records.transition(as(claimant), record.id, 'submit', { expectedVersion: record.version });
  return record.id;
}

const entriesFor = (recordId: string) =>
  w.platform.db.withTenant(w.ngoA, async (tx) =>
    (await tx.query<{ n: string }>(`select count(*)::text as n from journal_entry where source_record_id = $1`, [recordId]))[0]!.n,
  );

const status = async (recordId: string) => (await w.platform.records.get(as(ann), recordId)).status;

describe('expense claim approvals', () => {
  it('asks for a second person on Approve and on Pay', async () => {
    const workflow = (await w.platform.definitions.get(w.ngoA, 'workflow', 'expenseClaim'))!.body;
    const step = (key: string) => workflow.transitions.find((t) => t.key === key)!;
    expect(step('approve').approval).toEqual({ roles: ['expense-approver'], count: 1 });
    expect(step('pay').approval).toEqual({ roles: ['expense-approver'], count: 1 });
    expect(step('submit').approval).toBeUndefined();
    expect(step('reject').approval).toBeUndefined();
  });

  it('does not let the person who asks approve their own request, and lets a second person do it', async () => {
    const id = await submittedClaim();
    await expectCode(w.platform.records.transition(as(claimant), id, 'approve', { expectedVersion: 2 }), 'forbidden');

    const record = await w.platform.records.get(as(ann), id);
    const asked = await w.platform.records.transition(as(ann), id, 'approve', { expectedVersion: record.version });
    expect(asked.approvalRequestId).toBeTruthy();
    expect(await status(id)).toBe('submitted');
    expect((await w.platform.approvals.pendingForRecord(as(ann), id))!.canDecide).toBe(false);

    await expectCode(w.platform.approvals.decide(as(ann), asked.approvalRequestId!, 'approve'), 'forbidden');
    await expectCode(w.platform.approvals.decide(as(claimant), asked.approvalRequestId!, 'approve'), 'forbidden');

    expect((await w.platform.approvals.pendingForRecord(as(bob), id))!.canDecide).toBe(true);
    expect(await w.platform.approvals.decide(as(bob), asked.approvalRequestId!, 'approve')).toMatchObject({ status: 'approved' });
    expect(await status(id)).toBe('approved');
    await expectCode(w.platform.approvals.decide(as(bob), asked.approvalRequestId!, 'approve'), 'rule_violation');
  });

  it('carries the Pay form with the request and posts to the books only after the second person approves', async () => {
    const id = await submittedClaim();
    const approve = await w.platform.records.transition(as(ann), id, 'approve', { expectedVersion: (await w.platform.records.get(as(ann), id)).version });
    await w.platform.approvals.decide(as(bob), approve.approvalRequestId!, 'approve');
    expect(await status(id)).toBe('approved');

    const approved = await w.platform.records.get(as(bob), id);
    const pay = await w.platform.records.transition(as(bob), id, 'pay', {
      expectedVersion: approved.version,
      data: { paidFrom: 'BANK', paidOn: today() },
    });
    expect(pay.approvalRequestId).toBeTruthy();
    expect(await status(id)).toBe('approved');
    expect(await entriesFor(id)).toBe('0');

    await expectCode(w.platform.approvals.decide(as(bob), pay.approvalRequestId!, 'approve'), 'forbidden');
    expect(await w.platform.approvals.decide(as(ann), pay.approvalRequestId!, 'approve')).toMatchObject({ status: 'approved' });

    const paid = await w.platform.records.get(as(ann), id);
    expect(paid.status).toBe('paid');
    expect(paid.data).toMatchObject({ paidFrom: 'BANK', paidOn: today() });
    expect(await entriesFor(id)).toBe('1');
    const lines = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ code: string; debit: string; credit: string }>(
        `select a.code, l.debit::text, l.credit::text from journal_line l
           join journal_entry e on e.id = l.entry_id join ledger_account a on a.id = l.account_id
          where e.source_record_id = $1 order by a.code`,
        [id],
      ),
    );
    expect(lines).toEqual([
      { code: 'BANK', debit: '0.00', credit: '1200.00' },
      { code: 'EXP_TRAVEL', debit: '1200.00', credit: '0.00' },
    ]);
  });

  it('refuses a payment the account cannot cover when it is asked for, and lets it through with a reason that is kept', async () => {
    // The first claim above took 1200 of the 2000, so 800 is left and this claim of 1200 is short by 400.
    const id = await submittedClaim();
    const approve = await w.platform.records.transition(as(ann), id, 'approve', { expectedVersion: (await w.platform.records.get(as(ann), id)).version });
    await w.platform.approvals.decide(as(bob), approve.approvalRequestId!, 'approve');
    const version = (await w.platform.records.get(as(bob), id)).version;

    const refused = await expectCode(
      w.platform.records.transition(as(bob), id, 'pay', { expectedVersion: version, data: { paidFrom: 'BANK', paidOn: today() } }),
      'validation_failed',
    );
    expect((refused as Error & { issues?: { path: string }[] }).issues).toEqual([expect.objectContaining({ path: '/overdraftReason' })]);
    expect(await w.platform.approvals.pendingForRecord(as(bob), id)).toBeNull();

    const pay = await w.platform.records.transition(as(bob), id, 'pay', {
      expectedVersion: version,
      data: { paidFrom: 'BANK', paidOn: today(), overdraftReason: 'Grant instalment due on Monday' },
    });
    expect(pay.approvalRequestId).toBeTruthy();
    await w.platform.approvals.decide(as(ann), pay.approvalRequestId!, 'approve');
    expect(await status(id)).toBe('paid');
    expect(Number((await w.platform.moneyAccounts.get(as(ann), 'upi')).balance)).toBe(-400);

    const [kept] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ after: { reason: string } }>(
        `select a.after from audit_event a join journal_entry e on e.id::text = a.entity_id
          where a.action = 'ledger.overdraft_override' and e.source_record_id = $1`,
        [id],
      ),
    );
    expect(kept!.after.reason).toBe('Grant instalment due on Monday');
  });

  it('keeps Do not approve as a single step, with no second person', async () => {
    const id = await submittedClaim();
    const record = await w.platform.records.get(as(ann), id);
    const res = await w.platform.records.transition(as(ann), id, 'reject', { expectedVersion: record.version, data: { notes: 'No bill for the taxi.' } });
    expect(res.approvalRequestId).toBeUndefined();
    expect(await status(id)).toBe('rejected');
  });
});
