import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { actionPermission, actionPermissionsByType } from '../src/runtime/definitions/action-permissions.js';
import type { ActionDef, DefinitionKind } from '../src/runtime/definitions/types.js';
import { admin, clerk, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

let w: TestWorld;
let personId: string;
let failWebhooks = false;
const webhookCalls: Record<string, unknown>[] = [];

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
const donation = async (data: Record<string, unknown> = {}) =>
  (await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Meera', amount: 500, ...data })).record;
const paidDonation = async (data: Record<string, unknown> = {}) => {
  const d = await donation(data);
  return (await w.platform.records.transition(w.as(w.ngoA), d.id, 'markPaid', { data: { method: 'cash', paidOn: today() }, expectedVersion: d.version })).record;
};
const run = (id: string, key: string, input: Record<string, unknown> = {}, actor: Actor = admin, expectedVersion?: number) =>
  w.platform.actions.run(w.as(w.ngoA, actor), 'donation', id, key, { input, expectedVersion });
const outbox = (type: string) =>
  w.platform.db.asSystem((tx) =>
    tx.query<{ payload: Record<string, unknown>; status: string; last_error: string | null }>(
      `select payload, status, last_error from outbox_event where tenant_id = $1 and type = $2 order by created_at`,
      [w.ngoA, type],
    ),
  );

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await completeIdentity(w, w.ngoA);
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ('desk@example.org', 'Front desk') returning id`),
  );
  personId = u!.id;
  await w.platform.db.asSystem((tx) => tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, personId]));
  await w.platform.moneyAccounts.open(w.as(w.ngoA), { key: 'upi', name: 'SBI current', kind: 'bank', upiId: 'asha.trust@sbi' });
  await w.platform.connectors.save(w.as(w.ngoA), 'crm', { kind: 'webhook', config: { url: 'https://crm.test/hooks' }, enabled: false });
  w.platform.dispatcher.on('connector.webhook', 'test', async (e) => {
    webhookCalls.push(e.payload);
    if (failWebhooks) throw new Error('crm is down');
  });

  await publish('action', {
    key: 'flag',
    recordType: 'donation',
    label: 'Flag',
    placement: ['panel'],
    when: "status == 'raised'",
    form: {
      fields: [
        { key: 'note', label: 'Note', type: 'text', required: true, maxLength: 50 },
        { key: 'priority', label: 'Priority', type: 'choice', choices: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] },
      ],
    },
    steps: [
      { type: 'setFields', values: { notes: "input.note + ' (' + coalesce(input.priority, 'low') + ')'" } },
      { type: 'webhook', connector: 'crm', body: { note: 'input.note', amount: 'record.amount', notes: 'record.notes' } },
    ],
  });
  await publish('action', {
    key: 'settle',
    recordType: 'donation',
    label: 'Settle in cash',
    placement: ['panel'],
    steps: [{ type: 'transition', transition: 'markPaid', values: { method: "'cash'", paidOn: 'today()' } }, { type: 'openReceipt' }],
  });
  await publish('action', {
    key: 'followUp',
    recordType: 'donation',
    label: 'Follow up',
    placement: ['panel'],
    form: { fields: [{ key: 'amount', label: 'Amount', type: 'money', required: true }] },
    steps: [
      { type: 'createRecord', recordType: 'donation', values: { donorName: 'record.donorName', amount: 'input.amount', notes: "'Follow-up of ' + record.number" } },
      { type: 'notify', template: 'donationReminder', to: { users: [personId] }, channels: ['inApp'] },
    ],
  });
  await publish('action', {
    key: 'noteThenPrint',
    recordType: 'donation',
    label: 'Note then print',
    placement: ['panel'],
    steps: [{ type: 'setFields', values: { notes: "'changed'" } }, { type: 'openReceipt' }],
  });
});
afterAll(() => w.close());

describe('running an action', () => {
  it('validates the form, sets fields from input and queues the webhook with evaluated body', async () => {
    const d = await donation();
    const res = await run(d.id, 'flag', { note: 'Call back', priority: 'high' });
    expect(res.record).toMatchObject({ id: d.id, version: d.version + 1, data: { notes: 'Call back (high)' } });
    expect(res.message).toBe('Flag: done.');
    expect(res.open).toBeUndefined();
    const hook = (await outbox('connector.webhook')).at(-1)!;
    expect(hook.payload).toMatchObject({
      connector: 'crm',
      event: 'action.flag',
      record: { id: d.id, type: 'donation', number: d.number, status: 'raised' },
      body: { note: 'Call back', amount: 500, notes: 'Call back (high)' },
      actorId: admin.id,
    });
  });

  it('rejects form values that do not match the action fields', async () => {
    const d = await donation();
    const missing = await expectCode(run(d.id, 'flag', {}), 'validation_failed');
    expect((missing as Error & { issues?: unknown[] }).issues).toEqual([{ path: '/note', message: 'is required' }]);
    await expectCode(run(d.id, 'flag', { note: 'x', priority: 'urgent' }), 'validation_failed');
    await expectCode(run(d.id, 'flag', { note: 'x', extra: 1 }), 'validation_failed');
    await expectCode(run(d.id, 'flag', { note: 'x'.repeat(51) }), 'validation_failed');
    expect((await w.platform.records.get(w.as(w.ngoA), d.id)).version).toBe(d.version);
  });

  it('needs the action permission, and that permission alone is enough to run its steps', async () => {
    const d = await donation();
    await expectCode(run(d.id, 'flag', { note: 'x' }, clerk), 'forbidden');
    const flagger: Actor = { id: 'flagger', roles: [], permissions: ['record:donation:read', 'record:donation:action:flag'] };
    const res = await run(d.id, 'flag', { note: 'By flagger' }, flagger);
    expect(res.record.data.notes).toBe('By flagger (low)');
    const noRead: Actor = { id: 'blind', roles: [], permissions: ['record:donation:action:flag'] };
    await expectCode(run(d.id, 'flag', { note: 'x' }, noRead), 'forbidden');
  });

  it('is refused when its condition is false, and unknown actions or record types are not found', async () => {
    const paid = await paidDonation();
    const err = await expectCode(run(paid.id, 'flag', { note: 'x' }), 'rule_violation');
    expect(err.message).toBe("'Flag' is not available for this record.");
    await expectCode(run(paid.id, 'nope'), 'not_found');
    await expectCode(w.platform.actions.run(w.as(w.ngoA), 'donor', paid.id, 'flag', { input: { note: 'x' } }), 'not_found');
    await expectCode(w.platform.actions.run(w.as(w.ngoB), 'donation', paid.id, 'flag', { input: { note: 'x' } }), 'not_found');
  });

  it('refuses a stale expected version', async () => {
    const d = await donation();
    await expectCode(run(d.id, 'flag', { note: 'x' }, admin, d.version + 3), 'conflict');
    expect((await run(d.id, 'flag', { note: 'x' }, admin, d.version)).record.version).toBe(d.version + 1);
  });

  it('runs a workflow step and opens the receipt it issued', async () => {
    const d = await donation({ amount: 1200 });
    const res = await run(d.id, 'settle');
    expect(res.record).toMatchObject({ status: 'paid', data: { method: 'cash', paidOn: today() } });
    const receipts = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), d.id));
    expect(receipts).toHaveLength(1);
    expect(res.open).toBe(`/print/receipt/${receipts[0]!.id}`);
  });

  it('opens the latest receipt with the shipped Print receipt action, only for paid donations', async () => {
    const paid = await paidDonation();
    const [receipt] = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), paid.id));
    const res = await run(paid.id, 'printReceipt');
    expect(res).toMatchObject({ open: `/print/receipt/${receipt!.id}`, record: { id: paid.id, version: paid.version } });
    await expectCode(run((await donation()).id, 'printReceipt'), 'rule_violation');
  });

  it('runs every step in one transaction: a failing later step undoes earlier record changes', async () => {
    const d = await donation({ notes: 'original' });
    const before = (await outbox('connector.webhook')).length;
    const err = await expectCode(run(d.id, 'noteThenPrint'), 'rule_violation');
    expect(err.message).toBe('This record has no receipt to print yet.');
    expect(await w.platform.records.get(w.as(w.ngoA), d.id)).toMatchObject({ version: d.version, data: { notes: 'original' } });
    expect((await outbox('connector.webhook')).length).toBe(before);
  });

  it('creates a record and queues the in-app notification through the outbox', async () => {
    const d = await donation({ donorName: 'Kabir' });
    const notes = () =>
      w.platform.db.withTenant(w.ngoA, (tx) =>
        tx.query<{ subject: string; record_id: string }>(`select subject, record_id from notification where user_id = $1 and channel = 'inApp'`, [personId]),
      );
    await run(d.id, 'followUp', { amount: 250 });
    const created = await w.platform.records.query(w.as(w.ngoA), 'donation', { search: 'Kabir' });
    expect(created.items.map((r) => r.data.amount).sort()).toEqual([250, 500]);
    expect(created.items.find((r) => r.data.amount === 250)!.data.notes).toBe(`Follow-up of ${d.number}`);
    expect(await notes()).toEqual([]);
    expect((await outbox('action.notify')).at(-1)!.payload).toMatchObject({ template: 'donationReminder', recordId: d.id });
    await w.platform.dispatcher.runOnce();
    expect(await notes()).toEqual([{ subject: 'A reminder about your pledge, Kabir', record_id: d.id }]);
  });

  it('sends the shipped reminder email to the donor after the request', async () => {
    const d = await donation({ donorName: 'Ishaan', donorEmail: 'ishaan@example.org' });
    await expectCode(run((await donation()).id, 'sendReminder'), 'rule_violation');
    const res = await run(d.id, 'sendReminder');
    expect(res.record.version).toBe(d.version);
    expect(w.mail.sent.some((m) => m.to === 'ishaan@example.org')).toBe(false);
    await w.platform.dispatcher.runOnce();
    expect(w.mail.sent.find((m) => m.to === 'ishaan@example.org')?.subject).toBe('A reminder about your pledge, Ishaan');
  });

  it('creates a UPI payment request with the shipped Pay now action; payment marks the donation paid', async () => {
    const d = await donation({ amount: 751 });
    const res = await run(d.id, 'payNow');
    expect(res.payment).toMatchObject({ recordId: d.id, provider: 'upi_direct', amount: '751.00', status: 'awaiting_payment' });
    expect(res.open).toBe(res.payment!.upiLink);
    expect(res.open).toMatch(/^upi:\/\/pay\?pa=asha.trust%40sbi&pn=Asha\+Trust&am=751.00/);
    await expectCode(run(d.id, 'payNow'), 'rule_violation');
    await w.platform.payments.confirmManually(w.as(w.ngoA), res.payment!.id, { paidOn: today(), bankReference: 'UTR777' });
    await w.platform.dispatcher.runOnce();
    expect(await w.platform.records.get(w.as(w.ngoA), d.id)).toMatchObject({ status: 'paid', data: { method: 'upi', reference: 'UTR777' } });
  });

  it('keeps the record change when webhook delivery fails', async () => {
    const d = await donation();
    failWebhooks = true;
    try {
      await run(d.id, 'flag', { note: 'Webhook down' });
      const result = await w.platform.dispatcher.runOnce();
      expect(result.retried).toBeGreaterThanOrEqual(1);
    } finally {
      failWebhooks = false;
    }
    expect(webhookCalls.at(-1)).toMatchObject({ record: { id: d.id }, body: { note: 'Webhook down' } });
    expect((await outbox('connector.webhook')).at(-1)).toMatchObject({ status: 'pending', last_error: 'crm is down' });
    expect(await w.platform.records.get(w.as(w.ngoA), d.id)).toMatchObject({ version: d.version + 1, data: { notes: 'Webhook down (low)' } });
  });
});

describe('restricted records', () => {
  const reader = (id: string, extra: string[] = []): Actor => ({
    id,
    roles: [],
    permissions: ['record:memo:read', 'record:memo:action:*', ...extra],
  });
  let memoId: string;
  beforeAll(async () => {
    await publish('recordType', {
      key: 'memo',
      label: 'Memo',
      visibility: 'restricted',
      fields: [
        { key: 'text', label: 'Text', type: 'text', required: true },
        { key: 'secret', label: 'Secret', type: 'text', sensitive: true },
      ],
    });
    await publish('action', {
      key: 'stamp',
      recordType: 'memo',
      label: 'Stamp',
      placement: ['panel'],
      steps: [{ type: 'setFields', values: { text: "record.text + ' ✓'" } }],
    });
    await publish('action', {
      key: 'ping',
      recordType: 'memo',
      label: 'Ping',
      placement: ['panel'],
      steps: [{ type: 'notify', template: 'donationReminder', to: { creator: true }, channels: ['inApp'] }],
    });
    memoId = (await w.platform.records.create(w.as(w.ngoA, reader('author', ['record:memo:create'])), 'memo', { text: 'Private', secret: 'S1' })).record.id;
    await w.platform.db.withTenant(w.ngoA, (tx) =>
      w.platform.receipts.issue(asTx(tx), admin, { seriesKey: 'donation-receipt', date: today(), amount: 100, recordId: memoId }),
    );
  });
  const share = (principal: string, access: 'read' | 'edit') =>
    w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query(
        `insert into record_share (tenant_id, record_id, principal_kind, principal, access, created_by) values (app_tenant(), $1, 'user', $2, $3, 'author')`,
        [memoId, principal, access],
      ),
    );
  const memoAction = (actor: Actor, key: string) => w.platform.actions.run(w.as(w.ngoA, actor), 'memo', memoId, key);

  it('needs to see the record, and an edit share for actions that change it', async () => {
    await expectCode(memoAction(reader('stranger'), 'ping'), 'not_found');
    await share('reader', 'read');
    expect((await memoAction(reader('reader'), 'ping')).message).toBe('Ping: done.');
    await expectCode(memoAction(reader('reader'), 'stamp'), 'not_found');
    await share('editor', 'edit');
    expect((await memoAction(reader('editor'), 'stamp')).record.data).toEqual({ text: 'Private ✓', secret: '***' });
    expect((await memoAction(reader('author'), 'stamp')).record.data.text).toBe('Private ✓ ✓');
  });
});

describe('receipt print view', () => {
  it('returns the receipt, its record, series and organisation, with sensitive fields masked', async () => {
    const paid = await paidDonation({ donorPan: 'ABCDE1234F', amount: 999 });
    const [receipt] = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), paid.id));
    // Opening the print view needs the Print receipt action, not read access alone (DEF-08).
    const viewer: Actor = { id: 'viewer', roles: ['viewer'], permissions: ['record:donation:read', 'record:donation:action:printReceipt'] };
    const view = await w.platform.printView.receipt(w.as(w.ngoA, viewer), receipt!.id);
    expect(view).toMatchObject({
      receipt: { id: receipt!.id, number: receipt!.number, amount: '999.00', status: 'issued', recordId: paid.id },
      series: { key: 'donation-receipt', label: 'Donation acknowledgement', prefix: 'RCPT' },
      record: { id: paid.id, status: 'paid', data: { donorName: 'Meera', donorPan: '***' } },
      recordType: { key: 'donation', label: 'Donation', titleField: 'donorName' },
      organisation: { name: 'Asha Trust' },
    });
    const full = await w.platform.printView.receipt(w.as(w.ngoA, { ...viewer, permissions: [...viewer.permissions, 'record:donation:sensitive'] }), receipt!.id);
    expect(full.record.data.donorPan).toBe('ABCDE1234F');
  });

  it('needs read access to the linked record, including restricted visibility', async () => {
    const paid = await paidDonation();
    const [receipt] = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), paid.id));
    await expectCode(w.platform.printView.receipt(w.as(w.ngoA, { id: 'x', roles: [], permissions: ['record:donor:read'] }), receipt!.id), 'forbidden');
    await expectCode(w.platform.printView.receipt(w.as(w.ngoB), receipt!.id), 'not_found');
    await expectCode(w.platform.printView.receipt(w.as(w.ngoA), 'not-a-uuid'), 'not_found');

    const [memoReceipt] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ id: string }>(`select r.id from receipt r join record m on m.id = r.record_id where m.type_key = 'memo'`),
    );
    const memoReader = (id: string, extra: string[] = []): Actor => ({ id, roles: [], permissions: ['record:memo:read', 'record:memo:action:*', ...extra] });
    // Row-level access is still what decides whether the record is found at all.
    await expectCode(w.platform.printView.receipt(w.as(w.ngoA, memoReader('outsider')), memoReceipt!.id), 'not_found');
    // Memo has no action that opens a receipt, so nobody may print one (DEF-08).
    await expectCode(w.platform.printView.receipt(w.as(w.ngoA, memoReader('reader')), memoReceipt!.id), 'forbidden');
    await expectCode(w.platform.printView.receipt(w.as(w.ngoA, memoReader('boss', ['record:memo:read:all'])), memoReceipt!.id), 'forbidden');
  });

  it('DEF-08: refuses the print view to someone who may read the record but not print its receipt', async () => {
    const paid = await paidDonation();
    const [receipt] = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.forRecord(asTx(tx), paid.id));
    const viewer: Actor = { id: 'viewer', roles: ['viewer'], permissions: ['record:donation:read'] };
    await expectCode(w.platform.printView.receipt(w.as(w.ngoA, viewer), receipt!.id), 'forbidden');
  });
});

describe('HTTP', () => {
  it('runs actions and serves print data', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
    const d = await donation();
    const ok = await app.inject({
      method: 'POST',
      url: `/api/records/donation/${d.id}/actions/settle`,
      headers: headers(admin),
      payload: { input: {}, expectedVersion: d.version },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { record: { status: string }; message: string; open: string };
    expect(body).toMatchObject({ record: { status: 'paid' }, message: 'Settle in cash: done.' });
    const denied = await app.inject({ method: 'POST', url: `/api/records/donation/${d.id}/actions/settle`, headers: headers(clerk), payload: {} });
    expect(denied.statusCode).toBe(403);
    const invalid = await app.inject({ method: 'POST', url: `/api/records/donation/${d.id}/actions/flag`, headers: headers(admin), payload: { input: [] } });
    expect(invalid.statusCode).toBe(400);
    const refused = await app.inject({ method: 'POST', url: `/api/records/donation/${d.id}/actions/flag`, headers: headers(admin), payload: { input: { priority: 'urgent' } } });
    expect(refused.statusCode).toBe(422);

    const receiptId = body.open.split('/').at(-1)!;
    const print = await app.inject({ method: 'GET', url: `/api/print/receipt/${receiptId}`, headers: headers(admin) });
    expect(print.statusCode).toBe(200);
    expect(print.json()).toMatchObject({ receipt: { id: receiptId }, record: { id: d.id }, organisation: { name: 'Asha Trust' } });
    await app.close();
  });
});

describe('action permissions', () => {
  it('lists every action permission per record type for the permission catalogue', async () => {
    const defs = (await w.platform.definitions.list(w.ngoA, 'action')).map((a) => a.body as ActionDef);
    const byType = actionPermissionsByType(defs);
    expect(byType.donation!.map((a) => a.permission)).toEqual(
      expect.arrayContaining(['record:donation:action:payNow', 'record:donation:action:printReceipt', 'record:donation:action:sendReminder']),
    );
    expect(byType.memo).toEqual([
      { action: 'ping', label: 'Ping', permission: 'record:memo:action:ping' },
      { action: 'stamp', label: 'Stamp', permission: 'record:memo:action:stamp' },
    ]);
    expect(actionPermission({ key: 'x', recordType: 'donation', permission: 'custom:x' })).toBe('custom:x');
  });
});
