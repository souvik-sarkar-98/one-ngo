import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectorRequest, ConnectorResponse } from '../src/infrastructure/connectors/http.js';
import { enqueueEvent } from '../src/infrastructure/postgres/stores/audit-store.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { completeIdentity, createWorld, today, type TestWorld } from './helpers.js';

/** Records every outbound request; nothing reaches the network. */
const calls: ConnectorRequest[] = [];
const fakeHttp = async (req: ConnectorRequest): Promise<ConnectorResponse> => {
  calls.push(req);
  return { status: 200, body: '{"ok":true}' };
};

let w: TestWorld;
let maker: Actor;
let checker: Actor;

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
const donation = async (data: Record<string, unknown> = {}) =>
  (await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Meera', amount: 500, ...data })).record;
const run = () => w.platform.dispatcher.runOnce();

interface EventRow {
  id: string;
  status: string;
  attempts: number;
  done_handlers: string[];
  payload: Record<string, unknown>;
}
const events = (type: string) =>
  w.platform.db.asSystem((tx) =>
    tx.query<EventRow>(`select id, status, attempts, done_handlers, payload from outbox_event where tenant_id = $1 and type = $2 order by created_at`, [
      w.ngoA,
      type,
    ]),
  );
const lastEvent = async (type: string, match: (p: Record<string, unknown>) => boolean = () => true) =>
  (await events(type)).filter((e) => match(e.payload)).at(-1)!;
const setEvent = (id: string, assignments: string) =>
  w.platform.db.asSystem((tx) => tx.query(`update outbox_event set ${assignments} where id = $1`, [id]));
/** What a run leaves when the handler's own work was saved but recording the handler was not: due again, nothing recorded. */
const replayUnrecorded = (id: string) =>
  setEvent(id, `status = 'pending', available_at = now(), processed_at = null, locked_until = null, done_handlers = '{}'`);
/** What a run leaves when every handler finished but marking the event done failed. */
const replayAfterMarkDoneFailed = (id: string) => setEvent(id, `status = 'pending', available_at = now(), processed_at = null, locked_until = null`);
const dueNow = () => w.platform.db.asSystem((tx) => tx.query(`update outbox_event set available_at = now() where status = 'pending'`));

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, connectorHttp: fakeHttp });
  await completeIdentity(w, w.ngoA);
  const ctx = w.as(w.ngoA);
  await w.platform.moneyAccounts.open(ctx, { key: 'upi', name: 'SBI current', kind: 'bank', upiId: 'asha.trust@sbi' });
  await w.platform.connectors.save(ctx, 'crm', { kind: 'webhook', config: { url: 'https://crm.test/hooks' }, secrets: { signingSecret: 'whsec-1' }, enabled: true });
  await w.platform.connectors.save(ctx, 'gateway', {
    kind: 'sms',
    config: { url: 'https://sms.test/send', method: 'POST', body: '{"to":"{{to}}","text":"{{message}}"}' },
    secrets: { apiKey: 'k' },
    enabled: true,
  });
  await publish('action', {
    key: 'tellCrm',
    recordType: 'donation',
    label: 'Tell the CRM',
    placement: ['panel'],
    steps: [{ type: 'webhook', connector: 'crm', body: { amount: 'record.amount' } }],
  });
  await w.platform.connectors.save(ctx, 'chat', {
    kind: 'http',
    config: { mode: 'send', method: 'POST', url: 'https://chat.test/post', body: '{"amount":"{{record.amount}}"}' },
    enabled: true,
  });
  await publish('action', {
    key: 'tellChat',
    recordType: 'donation',
    label: 'Tell the chat',
    placement: ['panel'],
    steps: [{ type: 'connector', connector: 'chat', body: { amount: 'record.amount' } }],
  });
  await publish('template', { key: 'replayNote', subject: 'Thanks {{ record.donorName }}', body: 'Thank you.' });
  await publish('automation', {
    key: 'autoPay',
    recordType: 'donation',
    trigger: { event: 'created' },
    condition: "record.notes == 'auto-pay'",
    actions: [
      { type: 'transition', transition: 'markPaid', values: { method: "'cash'", paidOn: 'today()' } },
      { type: 'notify', template: 'replayNote', to: { email: "'auto@example.org'" }, channels: ['email'] },
    ],
  });

  await w.platform.identity.upsertRole(ctx, { key: 'approver', label: 'Approver', permissions: ['record:grant:read'] });
  const [makerId, checkerId] = await Promise.all(
    ['maker', 'checker'].map((n) => w.platform.identity.addMember(ctx, { email: `${n}@example.org`, displayName: n, roles: n === 'maker' ? [] : ['approver'] })),
  );
  maker = { id: makerId!, roles: [], permissions: ['record:grant:*', 'record:grant:transition:*'] };
  checker = { id: checkerId!, roles: ['approver'], permissions: ['record:grant:read'] };
  await publish('recordType', {
    key: 'grant',
    label: 'Grant disbursement',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
    ],
  });
  await publish('workflow', {
    key: 'grant',
    recordType: 'grant',
    initial: 'draft',
    states: [
      { key: 'draft', label: 'Draft' },
      { key: 'approved', label: 'Approved', final: true },
    ],
    transitions: [{ key: 'approve', label: 'Approve disbursement', from: ['draft'], to: 'approved', approval: { roles: ['approver'], count: 1 } }],
  });
});
afterAll(() => w.close());
beforeEach(async () => {
  await run();
  calls.length = 0;
});

describe('outbox delivery contract', () => {
  it('records each handler as it finishes, and a retry runs only the ones that did not', async () => {
    const seen: string[] = [];
    let failSecond = true;
    w.platform.dispatcher.on('test.twoHandlers', 'first', async () => {
      seen.push('first');
    });
    w.platform.dispatcher.on('test.twoHandlers', 'second', async () => {
      seen.push('second');
      if (failSecond) throw new Error('second is down');
    });
    await w.platform.db.withTenant(w.ngoA, (tx) => enqueueEvent(tx, 'test.twoHandlers', {}));
    expect((await run()).retried).toBe(1);
    expect(await lastEvent('test.twoHandlers')).toMatchObject({ status: 'pending', done_handlers: ['first'] });

    failSecond = false;
    await dueNow();
    expect((await run()).processed).toBe(1);
    expect(seen).toEqual(['first', 'second', 'second']);
    expect(await lastEvent('test.twoHandlers')).toMatchObject({ status: 'done', done_handlers: ['first', 'second'] });
  });

  it('refuses two handlers with the same name for one event', () => {
    w.platform.dispatcher.on('test.named', 'only', async () => undefined);
    expect(() => w.platform.dispatcher.on('test.named', 'only', async () => undefined)).toThrow(/already registered/);
  });

  it('leaves an event to the run that claimed it after the lease ran out, which runs only the rest', async () => {
    const seen: string[] = [];
    let first = true;
    w.platform.dispatcher.on('test.lease', 'a', async (e) => {
      seen.push('a');
      if (first) {
        first = false;
        // Another run claims the event while this handler is still working.
        await setEvent(e.id, `attempts = attempts + 1, locked_until = now() + interval '5 minutes'`);
      }
    });
    w.platform.dispatcher.on('test.lease', 'b', async () => {
      seen.push('b');
    });
    await w.platform.db.withTenant(w.ngoA, (tx) => enqueueEvent(tx, 'test.lease', {}));
    expect(await run()).toEqual({ processed: 0, failed: 0, retried: 0 });
    expect(seen).toEqual(['a']);
    const claimed = await lastEvent('test.lease');
    expect(claimed).toMatchObject({ status: 'processing', attempts: 2, done_handlers: ['a'] });

    // That run's process stops; its lease runs out and the event is claimed once more.
    await setEvent(claimed.id, `locked_until = now() - interval '1 second'`);
    expect((await run()).processed).toBe(1);
    expect(seen).toEqual(['a', 'b']);
    expect(await lastEvent('test.lease')).toMatchObject({ status: 'done', done_handlers: ['a', 'b'] });
  });
});

describe('replayed events repeat no side effect', () => {
  it('emails: one message per notification', async () => {
    const before = w.mail.sent.length;
    await w.platform.notifications.notify(w.ngoA, { template: 'replayNote', to: { email: "'once@example.org'" }, channels: ['email'], scope: { record: { donorName: 'Uma' } } });
    await run();
    const event = await lastEvent('notification.email');
    expect(event.status).toBe('done');
    await replayUnrecorded(event.id);
    await run();
    await replayAfterMarkDoneFailed(event.id);
    await run();
    expect(w.mail.sent.slice(before).filter((m) => m.to === 'once@example.org')).toHaveLength(1);
    expect(await lastEvent('notification.email')).toMatchObject({ id: event.id, status: 'done' });
  });

  it('SMS: one call per notification', async () => {
    const d = await donation();
    await w.platform.notifications.notify(w.ngoA, {
      template: 'replayNote',
      to: { phone: "'+91 98765-43210'" },
      channels: ['sms'],
      scope: { record: { donorName: 'Om' } },
      recordId: d.id,
    });
    await run();
    expect(calls).toHaveLength(1);
    const event = await lastEvent('notification.sms');
    await replayUnrecorded(event.id);
    await run();
    expect(calls).toHaveLength(1);
    expect(await lastEvent('notification.sms')).toMatchObject({ id: event.id, status: 'done' });
  });

  it('webhooks: one call per event and connector, with one delivery row', async () => {
    const d = await donation();
    await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'tellCrm', { input: {} });
    await run();
    expect(calls).toHaveLength(1);
    const event = await lastEvent('connector.webhook');
    await replayUnrecorded(event.id);
    await run();
    await replayAfterMarkDoneFailed(event.id);
    await run();
    expect(calls).toHaveLength(1);
    const logs = (await w.platform.connectors.deliveries(w.as(w.ngoA), 'crm')).filter((l) => l.recordId === d.id);
    expect(logs).toEqual([expect.objectContaining({ status: 'sent', attempts: 1 })]);
    expect(await lastEvent('connector.webhook')).toMatchObject({ id: event.id, status: 'done' });
  });

  it('http connectors: one call per connector.http event, with one delivery row', async () => {
    const d = await donation({ amount: 321 });
    await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'tellChat', { input: {} });
    await run();
    expect(calls).toEqual([expect.objectContaining({ url: 'https://chat.test/post', body: '{"amount":"321"}' })]);
    const event = await lastEvent('connector.http');
    expect(event).toMatchObject({ status: 'done', payload: { connector: 'chat', recordId: d.id } });
    await replayUnrecorded(event.id);
    await run();
    await replayAfterMarkDoneFailed(event.id);
    await run();
    expect(calls).toHaveLength(1);
    const logs = (await w.platform.connectors.deliveries(w.as(w.ngoA), 'chat')).filter((l) => l.recordId === d.id);
    expect(logs).toEqual([expect.objectContaining({ event: 'action.tellChat', status: 'sent', attempts: 1 })]);
    expect(await lastEvent('connector.http')).toMatchObject({ id: event.id, status: 'done' });
  });

  it('automations: a transition and a message are not applied twice', async () => {
    const before = w.mail.sent.length;
    const d = await donation({ notes: 'auto-pay' });
    await run();
    await run();
    const paid = await w.platform.records.get(w.as(w.ngoA), d.id);
    expect(paid).toMatchObject({ status: 'paid', version: d.version + 1 });
    const created = await lastEvent('record.created', (p) => p.id === d.id);
    await replayUnrecorded(created.id);
    await run();
    await run();
    expect(await w.platform.records.get(w.as(w.ngoA), d.id)).toMatchObject({ status: 'paid', version: paid.version });
    expect(await lastEvent('record.created', (p) => p.id === d.id)).toMatchObject({ status: 'done' });
    expect(w.mail.sent.slice(before).filter((m) => m.to === 'auto@example.org')).toHaveLength(1);
  });

  it('payment confirmation: the paid step runs once', async () => {
    const d = await donation({ amount: 751 });
    const res = await w.platform.actions.run(w.as(w.ngoA), 'donation', d.id, 'payNow', { input: {} });
    await w.platform.payments.confirmManually(w.as(w.ngoA), res.payment!.id, { paidOn: today(), bankReference: 'UTR901' });
    await run();
    const paid = await w.platform.records.get(w.as(w.ngoA), d.id);
    expect(paid).toMatchObject({ status: 'paid', data: { reference: 'UTR901' } });
    const event = await lastEvent('payment.confirmed', (p) => p.intentId === res.payment!.id);
    expect(event).toMatchObject({ status: 'done', done_handlers: ['paidStep'] });
    await replayAfterMarkDoneFailed(event.id);
    await run();
    expect(await w.platform.records.get(w.as(w.ngoA), d.id)).toMatchObject({ status: 'paid', version: paid.version });
    expect(await lastEvent('payment.confirmed', (p) => p.intentId === res.payment!.id)).toMatchObject({ status: 'done' });
  });

  it('approvals: approvers and the requester are told once, even when another handler of the event fails', async () => {
    let failExtra = true;
    w.platform.dispatcher.on('approval.requested', 'test.flaky', async () => {
      if (failExtra) throw new Error('flaky');
    });
    const inbox = async (actor: Actor) => (await w.platform.notifications.inbox(w.as(w.ngoA, actor))).filter((n) => n.subject.includes('pproval') || n.subject.startsWith('Your request'));
    const { record } = await w.platform.records.create(w.as(w.ngoA, maker), 'grant', { title: 'School kits', amount: 5000 });
    const req = await w.platform.records.transition(w.as(w.ngoA, maker), record.id, 'approve', { expectedVersion: record.version });
    expect((await run()).retried).toBe(1);
    failExtra = false;
    await dueNow();
    await run();
    const requested = await lastEvent('approval.requested');
    expect(requested).toMatchObject({ status: 'done', done_handlers: ['notifyApprovers', 'test.flaky'] });
    expect(await inbox(checker)).toEqual([expect.objectContaining({ subject: 'Approval needed: Approve disbursement' })]);

    await replayAfterMarkDoneFailed(requested.id);
    await run();
    expect(await inbox(checker)).toHaveLength(1);

    await w.platform.approvals.decide(w.as(w.ngoA, checker), req.approvalRequestId!, 'approve');
    await run();
    const decided = await lastEvent('approval.decided');
    await replayAfterMarkDoneFailed(decided.id);
    await run();
    expect(await inbox(maker)).toEqual([expect.objectContaining({ subject: 'Your request was approved' })]);
  });

  it('publishing: rebuild jobs are queued once', async () => {
    await w.platform.records.create(w.as(w.ngoA, maker), 'grant', { title: 'Books', amount: 100 });
    await publish('recordType', {
      key: 'grant',
      label: 'Grant disbursement',
      fields: [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'amount', label: 'Amount', type: 'money', required: true },
        { key: 'region', label: 'Region', type: 'text', searchable: true },
      ],
    });
    await run();
    const jobs = () =>
      w.platform.db.asSystem((tx) =>
        tx.query<{ kind: string }>(`select kind from job where tenant_id = $1 and input->>'recordType' = 'grant' order by kind`, [w.ngoA]),
      );
    expect(await jobs()).toEqual([{ kind: 'search.rebuild' }]);
    const event = await lastEvent('definition.published', (p) => p.kind === 'recordType' && p.key === 'grant');
    expect(event).toMatchObject({ status: 'done', done_handlers: ['jobs'] });
    await replayAfterMarkDoneFailed(event.id);
    await run();
    expect(await jobs()).toEqual([{ kind: 'search.rebuild' }]);
  });
});
