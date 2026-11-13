import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { admin, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let maker: Actor;
let checker1: Actor;
let checker2: Actor;

beforeAll(async () => {
  w = await createWorld();
  await completeIdentity(w, w.ngoA);
  const ctx = w.as(w.ngoA);
  await w.platform.identity.upsertRole(ctx, { key: 'approver', label: 'Approver', permissions: ['record:grant:read'] });
  const ids = await Promise.all(
    ['maker', 'checker1', 'checker2'].map((n) =>
      w.platform.identity.addMember(ctx, { email: `${n}@example.org`, displayName: n, roles: n === 'maker' ? [] : ['approver'] }),
    ),
  );
  maker = { id: ids[0]!, roles: [], permissions: ['record:grant:*', 'record:grant:transition:*'] };
  checker1 = { id: ids[1]!, roles: ['approver'], permissions: ['record:grant:read'] };
  checker2 = { id: ids[2]!, roles: ['approver'], permissions: ['record:grant:read'] };

  await w.platform.definitions.saveDraft(ctx, 'recordType', {
    key: 'grant',
    label: 'Grant disbursement',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
      { key: 'reviewNote', label: 'Review note', type: 'text' },
    ],
  });
  await w.platform.definitions.publish(ctx, 'recordType', 'grant');
  await w.platform.definitions.saveDraft(ctx, 'workflow', {
    key: 'grant',
    recordType: 'grant',
    initial: 'draft',
    states: [
      { key: 'draft', label: 'Draft' },
      { key: 'approved', label: 'Approved', final: true },
    ],
    transitions: [
      {
        key: 'approve',
        label: 'Approve disbursement',
        from: ['draft'],
        to: 'approved',
        approval: { roles: ['approver'], count: 2, when: 'record.amount >= 10000' },
      },
    ],
  });
  await w.platform.definitions.publish(ctx, 'workflow', 'grant');
});
afterAll(() => w.close());

describe('approvals', () => {
  it('needs two different approvers, never the requester, before the step runs', async () => {
    const ctx = w.as(w.ngoA, maker);
    const { record } = await w.platform.records.create(ctx, 'grant', { title: 'School kits', amount: 50000 });
    const req = await w.platform.records.transition(ctx, record.id, 'approve', { expectedVersion: 1 });
    expect(req.approvalRequestId).toBeDefined();
    expect(req.record.status).toBe('draft');

    await expectCode(w.platform.records.transition(ctx, record.id, 'approve', { expectedVersion: 1 }), 'rule_violation');
    expect(await w.platform.approvals.inbox(ctx)).toHaveLength(0);
    await expectCode(w.platform.approvals.decide(ctx, req.approvalRequestId!, 'approve'), 'forbidden');

    const inbox = await w.platform.approvals.inbox(w.as(w.ngoA, checker1));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ transitionLabel: 'Approve disbursement', approvalsNeeded: 2, requestedByName: 'maker' });

    expect(await w.platform.approvals.decide(w.as(w.ngoA, checker1), req.approvalRequestId!, 'approve')).toMatchObject({
      status: 'pending',
      approvalsGiven: 1,
    });
    await expectCode(w.platform.approvals.decide(w.as(w.ngoA, checker1), req.approvalRequestId!, 'approve'), 'rule_violation');
    const done = await w.platform.approvals.decide(w.as(w.ngoA, checker2), req.approvalRequestId!, 'approve');
    expect(done.status).toBe('approved');
    expect((await w.platform.records.get(ctx, record.id)).status).toBe('approved');
  });

  it('skips approval when its condition is false', async () => {
    const ctx = w.as(w.ngoA, maker);
    const { record } = await w.platform.records.create(ctx, 'grant', { title: 'Small', amount: 500 });
    const res = await w.platform.records.transition(ctx, record.id, 'approve', { expectedVersion: 1 });
    expect(res.approvalRequestId).toBeUndefined();
    expect(res.record.status).toBe('approved');
  });

  it('marks a request stale if the record changes before approval, and supports reject and withdraw', async () => {
    const ctx = w.as(w.ngoA, maker);
    const a = await w.platform.records.create(ctx, 'grant', { title: 'Changed', amount: 20000 });
    const ra = await w.platform.records.transition(ctx, a.record.id, 'approve', { expectedVersion: 1 });
    await w.platform.records.update(ctx, a.record.id, { expectedVersion: 1, data: { amount: 90000 } });
    await w.platform.approvals.decide(w.as(w.ngoA, checker1), ra.approvalRequestId!, 'approve');
    expect(await w.platform.approvals.decide(w.as(w.ngoA, checker2), ra.approvalRequestId!, 'approve')).toMatchObject({ status: 'stale' });
    expect((await w.platform.records.get(ctx, a.record.id)).status).toBe('draft');

    const b = await w.platform.records.create(ctx, 'grant', { title: 'Rejected', amount: 20000 });
    const rb = await w.platform.records.transition(ctx, b.record.id, 'approve', { expectedVersion: 1 });
    expect(await w.platform.approvals.decide(w.as(w.ngoA, checker1), rb.approvalRequestId!, 'reject', 'Budget exhausted')).toEqual({
      status: 'rejected',
    });

    const c = await w.platform.records.create(ctx, 'grant', { title: 'Withdrawn', amount: 20000 });
    const rc = await w.platform.records.transition(ctx, c.record.id, 'approve', { expectedVersion: 1 });
    await expectCode(w.platform.approvals.withdraw(w.as(w.ngoA, checker1), rc.approvalRequestId!), 'forbidden');
    await w.platform.approvals.withdraw(ctx, rc.approvalRequestId!);
    expect(await w.platform.approvals.inbox(w.as(w.ngoA, checker1))).toHaveLength(0);
  });

  it('notifies approvers and the requester through the dispatcher', async () => {
    await w.platform.dispatcher.runOnce();
    const checkerInbox = await w.platform.notifications.inbox(w.as(w.ngoA, checker1));
    expect(checkerInbox.some((n) => n.subject === 'Approval needed: Approve disbursement')).toBe(true);
    const makerInbox = await w.platform.notifications.inbox(w.as(w.ngoA, maker));
    expect(makerInbox.map((n) => n.subject)).toEqual(expect.arrayContaining(['Your request was approved', 'Your request was rejected']));
    await w.platform.notifications.markRead(w.as(w.ngoA, maker), makerInbox[0]!.id);
    expect(await w.platform.notifications.inbox(w.as(w.ngoA, maker), { unreadOnly: true })).toHaveLength(makerInbox.length - 1);
    await expectCode(w.platform.notifications.markRead(w.as(w.ngoA, checker1), makerInbox[1]!.id), 'not_found');
  });
});

describe('automations', () => {
  it('emails the donor when a donation is paid (shipped automation)', async () => {
    w.mail.sent.length = 0;
    const ctx = w.as(w.ngoA);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Kavya', donorEmail: 'kavya@example.org', amount: 1500 });
    await w.platform.records.transition(ctx, record.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn: today() } });
    const quiet = await w.platform.records.create(ctx, 'donation', { donorName: 'No email', amount: 10 });
    await w.platform.records.transition(ctx, quiet.record.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn: today() } });

    await w.platform.dispatcher.runOnce();
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0]).toMatchObject({ to: 'kavya@example.org', subject: 'Thank you for your donation, Kavya' });
    expect(w.mail.sent[0]!.text).toContain('Rs. 1500');
    expect(w.mail.sent[0]!.text).toContain(record.number!);
  });

  it('sets fields through the record engine and does not loop', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'automation', {
      key: 'stampReview',
      recordType: 'grant',
      trigger: { event: 'updated' },
      actions: [{ type: 'setFields', values: { reviewNote: "'Edited at version ' + text(record.amount)" } }],
    });
    await w.platform.definitions.publish(ctx, 'automation', 'stampReview');
    const { record } = await w.platform.records.create(ctx, 'grant', { title: 'Loop check', amount: 100 });
    await w.platform.records.update(ctx, record.id, { expectedVersion: 1, data: { amount: 200 } });
    await w.platform.dispatcher.runOnce();
    await w.platform.dispatcher.runOnce();
    const after = await w.platform.records.get(ctx, record.id);
    expect(after.data.reviewNote).toBe('Edited at version 200');
    expect(after.version).toBe(3);
  });

  it('rejects automations that refer to unknown fields, steps, or templates', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'automation', {
      key: 'broken',
      recordType: 'grant',
      trigger: { event: 'statusChanged', to: 'nowhere' },
      actions: [
        { type: 'setFields', values: { colour: "'red'" } },
        { type: 'notify', template: 'missing', to: { roles: ['approver'] } },
      ],
    });
    const err = await expectCode(w.platform.definitions.publish(ctx, 'automation', 'broken'), 'definition_invalid');
    const messages = (err as unknown as { issues: { message: string }[] }).issues.map((i) => i.message).join(' | ');
    expect(messages).toMatch(/unknown status 'nowhere'/);
    expect(messages).toMatch(/'colour' is not a writable field/);
    expect(messages).toMatch(/template 'missing' is not published/);
  });

  it('runs scheduled automations once per due time, for matching records', async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'automation', {
      key: 'monthlyNudge',
      recordType: 'grant',
      trigger: { event: 'schedule', cron: '0 3 1 * *', status: 'draft' },
      actions: [{ type: 'setFields', values: { reviewNote: "'Monthly reminder'" } }],
    });
    await w.platform.definitions.publish(ctx, 'automation', 'monthlyNudge');
    const { record } = await w.platform.records.create(ctx, 'grant', { title: 'Waiting', amount: 100 });

    expect((await w.platform.automations.tick(new Date('2026-10-20T00:00:00Z'))).automationsRun).toBe(0);
    expect((await w.platform.automations.tick(new Date('2026-10-25T00:00:00Z'))).automationsRun).toBe(0);
    const due = await w.platform.automations.tick(new Date('2026-11-01T04:00:00Z'));
    expect(due.automationsRun).toBe(1);
    expect(due.recordsProcessed).toBeGreaterThan(0);
    expect((await w.platform.records.get(ctx, record.id)).data.reviewNote).toBe('Monthly reminder');
    expect((await w.platform.automations.tick(new Date('2026-11-01T05:00:00Z'))).automationsRun).toBe(0);
  });

  it('retries failed events with backoff and keeps the error', async () => {
    const original = w.mail.send.bind(w.mail);
    w.mail.send = async () => {
      throw new Error('SMTP down');
    };
    const ctx = w.as(w.ngoA, admin);
    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Retry', donorEmail: 'retry@example.org', amount: 5 });
    await w.platform.records.transition(ctx, record.id, 'markPaid', { expectedVersion: 1, data: { method: 'cash', paidOn: today() } });
    const first = await w.platform.dispatcher.runOnce();
    expect(first.retried).toBeGreaterThan(0);
    const [row] = await w.platform.db.asSystem((tx) =>
      tx.query<{ status: string; last_error: string }>(`select status, last_error from outbox_event where type = 'notification.email' order by created_at desc limit 1`),
    );
    expect(row).toMatchObject({ status: 'pending', last_error: 'SMTP down' });
    w.mail.send = original;
  });
});
