import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalQuery } from '../src/runtime/workflows/approval-service.js';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let maker: Actor;
let amit: Actor;
let tara: Actor;
let nina: Actor;
let olga: Actor;
/** Pending request ids by record name. */
const req: Record<string, string> = {};
const rec: Record<string, string> = {};

const ROW_KEYS = [
  'id', 'recordId', 'recordType', 'recordTypeLabel', 'recordNumber', 'recordTitle', 'step', 'stepLabel', 'fromStatusLabel',
  'toStatusLabel', 'requestedBy', 'requestedByName', 'requestedAt', 'approvalsGiven', 'approvalsNeeded',
];

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  const ctx = w.as(w.ngoA);
  for (const key of ['approver', 'treasurer']) {
    await w.platform.identity.upsertRole(ctx, { key, label: key, permissions: ['record:grant:read', 'record:case:read'] });
  }
  const member = (name: string, roles: string[]) =>
    w.platform.identity.addMember(ctx, { email: `${name.split(' ')[0]!.toLowerCase()}@example.org`, displayName: name, roles });
  const read = ['record:grant:read', 'record:case:read'];
  maker = { id: await member('Maya Maker', []), roles: [], permissions: ['record:grant:*', 'record:grant:transition:*', 'record:case:*', 'record:case:transition:*'] };
  amit = { id: await member('Amit Approver', ['approver']), roles: ['approver'], permissions: [...read, 'record:grant:create', 'record:grant:transition:*'] };
  tara = { id: await member('Tara Treasurer', ['approver', 'treasurer']), roles: ['approver', 'treasurer'], permissions: read };
  nina = { id: await member('Nina Auditor', []), roles: [], permissions: read };
  olga = { id: await member('Olga Outsider', []), roles: [], permissions: read };

  const publish = async (kind: 'recordType' | 'workflow', body: Record<string, unknown>) => {
    await w.platform.definitions.saveDraft(ctx, kind, body as never);
    await w.platform.definitions.publish(ctx, kind, String(body.key));
  };
  await publish('recordType', {
    key: 'grant',
    label: 'Grant',
    numbering: { sequence: 'grant', format: 'GR/{seq:3}', reset: 'never' },
    titleField: 'title',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'money', required: true },
    ],
  });
  await publish('workflow', {
    key: 'grant',
    recordType: 'grant',
    initial: 'draft',
    states: [{ key: 'draft', label: 'Draft' }, { key: 'approved', label: 'Approved' }, { key: 'paid', label: 'Paid', final: true }],
    transitions: [
      { key: 'approve', label: 'Approve grant', from: ['draft'], to: 'approved', approval: { roles: ['approver'], count: 2 } },
      { key: 'pay', label: 'Pay grant', from: ['approved'], to: 'paid', approval: { roles: ['treasurer'] } },
    ],
  });
  await publish('workflow', {
    key: 'grantAudit',
    recordType: 'grant',
    role: 'parallel',
    initial: 'open',
    states: [{ key: 'open', label: 'Open for audit' }, { key: 'checked', label: 'Checked' }],
    transitions: [{ key: 'check', label: 'Check grant', from: ['open'], to: 'checked', approval: { users: [nina.id] } }],
  });
  await publish('recordType', {
    key: 'case',
    label: 'Case',
    numbering: { sequence: 'case', format: 'CASE/{seq:3}', reset: 'never' },
    titleField: 'name',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true, sensitive: true }],
  });
  await publish('workflow', {
    key: 'case',
    recordType: 'case',
    initial: 'new',
    states: [{ key: 'new', label: 'New' }, { key: 'accepted', label: 'Accepted', final: true }],
    transitions: [{ key: 'accept', label: 'Accept case', from: ['new'], to: 'accepted', approval: { roles: ['approver'] } }],
  });

  const request = async (who: Actor, type: string, name: string, data: Record<string, unknown>, step: string) => {
    const { record } = await w.platform.records.create(w.as(w.ngoA, who), type, data);
    rec[name] = record.id;
    const res = await w.platform.records.transition(w.as(w.ngoA, who), record.id, step, { expectedVersion: record.version });
    req[name] = res.approvalRequestId!;
  };
  await request(maker, 'grant', 'g1', { title: 'School kits', amount: 1000 }, 'approve');
  await request(maker, 'grant', 'g2', { title: 'Water pumps', amount: 2000 }, 'approve');
  await request(amit, 'grant', 'g3', { title: 'Library books', amount: 3000 }, 'approve');
  await request(maker, 'grant', 'g4', { title: 'Solar lamps', amount: 4000 }, 'check');
  await request(maker, 'grant', 'g5', { title: 'Clinic beds', amount: 5000 }, 'approve');
  await w.platform.approvals.decide(w.as(w.ngoA, amit), req.g5!, 'approve');
  expect(await w.platform.approvals.decide(w.as(w.ngoA, tara), req.g5!, 'approve')).toMatchObject({ status: 'approved' });
  const g5 = await w.platform.records.get(w.as(w.ngoA, maker), rec.g5!);
  req.g5 = (await w.platform.records.transition(w.as(w.ngoA, maker), g5.id, 'pay', { expectedVersion: g5.version })).approvalRequestId!;
  await request(maker, 'case', 'c1', { name: 'Ravi Secret' }, 'accept');

  const hoursAgo: Record<string, number> = { g1: 6, g2: 5, g3: 4, g4: 3, g5: 2, c1: 1 };
  await w.platform.db.asSystem(async (tx) => {
    for (const [name, h] of Object.entries(hoursAgo)) {
      await tx.query(`update approval_request set created_at = now() - make_interval(hours => $2) where id = $1`, [req[name], h]);
    }
  });
});
afterAll(() => w.close());

const names = (ids: string[]) => ids.map((id) => Object.keys(req).find((k) => req[k] === id));
const query = async (actor: Actor, q: ApprovalQuery = {}) => {
  const res = await w.platform.approvals.query(w.as(w.ngoA, actor), q);
  return { ...res, names: names(res.items.map((i) => i.id)) };
};

describe('approvals query', () => {
  it('lists exactly what decide would allow, for every person and request', async () => {
    for (const actor of [maker, amit, tara, nina, olga]) {
      const listed = new Set((await query(actor, { limit: 200 })).items.map((i) => i.id));
      for (const name of Object.keys(req)) {
        const pending = await w.platform.approvals.pendingForRecord(w.as(w.ngoA, actor), rec[name]!);
        expect([actor.id, name, pending!.canDecide]).toEqual([actor.id, name, listed.has(req[name]!)]);
      }
    }
    expect((await query(amit)).names).toEqual(['g1', 'g2', 'c1']);
    expect((await query(tara)).names).toEqual(['g1', 'g2', 'g3', 'g5', 'c1']);
    expect((await query(nina)).names).toEqual(['g4']);
    expect((await query(olga)).total).toBe(0);
    expect((await query(maker)).total).toBe(0);
    await expectCode(w.platform.approvals.decide(w.as(w.ngoA, olga), req.g1!, 'approve'), 'forbidden');
    await expectCode(w.platform.approvals.decide(w.as(w.ngoA, amit), req.g3!, 'approve'), 'forbidden');
    await expectCode(w.platform.approvals.decide(w.as(w.ngoA, amit), req.g5!, 'approve'), 'forbidden');
  });

  it('returns only the common workflow fields, with labels across several workflows', async () => {
    const { items } = await query(tara);
    for (const row of items) expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort());
    expect(items.find((i) => i.id === req.g2)).toEqual({
      id: req.g2,
      recordId: rec.g2,
      recordType: 'grant',
      recordTypeLabel: 'Grant',
      recordNumber: 'GR/002',
      recordTitle: 'Water pumps',
      step: 'approve',
      stepLabel: 'Approve grant',
      fromStatusLabel: 'Draft',
      toStatusLabel: 'Approved',
      requestedBy: maker.id,
      requestedByName: 'Maya Maker',
      requestedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      approvalsGiven: 0,
      approvalsNeeded: 2,
    });
    expect(items.find((i) => i.id === req.g5)).toMatchObject({ stepLabel: 'Pay grant', fromStatusLabel: 'Approved', toStatusLabel: 'Paid', approvalsNeeded: 1 });
    const c1 = items.find((i) => i.id === req.c1)!;
    expect(c1).toMatchObject({ recordTypeLabel: 'Case', recordNumber: 'CASE/001', recordTitle: 'CASE/001', fromStatusLabel: 'New', toStatusLabel: 'Accepted' });
    expect(JSON.stringify(items)).not.toContain('Ravi');
    expect((await query(nina)).items[0]).toMatchObject({ step: 'check', fromStatusLabel: 'Open for audit', toStatusLabel: 'Checked', recordTitle: 'Solar lamps' });
    expect((await query(tara, { filters: { requestedBy: [amit.id] } })).items[0]!.requestedByName).toBe('Amit Approver');
  });

  it('sorts, longest waiting first by default, and pages', async () => {
    const sorted = async (field: NonNullable<ApprovalQuery['sort']>['field'], dir: 'asc' | 'desc') => (await query(tara, { sort: { field, dir } })).names;
    expect(await sorted('waiting', 'desc')).toEqual(['g1', 'g2', 'g3', 'g5', 'c1']);
    expect(await sorted('waiting', 'asc')).toEqual(['c1', 'g5', 'g3', 'g2', 'g1']);
    expect(await sorted('record', 'asc')).toEqual(['c1', 'g1', 'g2', 'g3', 'g5']);
    expect(await sorted('record', 'desc')).toEqual(['g5', 'g3', 'g2', 'g1', 'c1']);
    expect(await sorted('type', 'asc')).toEqual(['c1', 'g1', 'g2', 'g3', 'g5']);
    expect(await sorted('step', 'desc')).toEqual(['g5', 'g1', 'g2', 'g3', 'c1']);
    expect(await sorted('requestedBy', 'asc')).toEqual(['g3', 'g1', 'g2', 'g5', 'c1']);

    expect(await query(tara, { limit: 2 })).toMatchObject({ names: ['g1', 'g2'], total: 5 });
    expect(await query(tara, { limit: 2, offset: 2 })).toMatchObject({ names: ['g3', 'g5'], total: 5 });
    expect(await query(tara, { limit: 2, offset: 4 })).toMatchObject({ names: ['c1'], total: 5 });
    expect(await query(tara, { limit: 2, offset: 10 })).toMatchObject({ names: [], total: 5 });
    await expectCode(w.platform.approvals.query(w.as(w.ngoA, tara), { sort: { field: 'amount' as never, dir: 'asc' } }), 'validation_failed');
  });

  it('filters by type, step and requester, and searches number and title', async () => {
    expect((await query(tara, { filters: { type: ['case'] } })).names).toEqual(['c1']);
    expect((await query(tara, { filters: { step: ['pay', 'accept'] } })).names).toEqual(['g5', 'c1']);
    expect((await query(tara, { filters: { requestedBy: [amit.id] } })).names).toEqual(['g3']);
    expect(await query(tara, { filters: { type: ['grant'], requestedBy: [maker.id] } })).toMatchObject({ names: ['g1', 'g2', 'g5'], total: 3 });
    expect((await query(tara, { filters: { step: ['check'] } })).total).toBe(0);

    expect((await query(tara, { search: 'water' })).names).toEqual(['g2']);
    expect((await query(tara, { search: 'GR/005' })).names).toEqual(['g5']);
    expect((await query(tara, { search: 'case/0' })).names).toEqual(['c1']);
    expect((await query(tara, { search: 'Ravi' })).total).toBe(0);
    expect((await query(tara, { search: '%' })).total).toBe(0);
    expect(await query(tara, { search: 'GR', filters: { step: ['approve'] }, limit: 1, offset: 1 })).toMatchObject({ names: ['g2'], total: 3 });
  });

  it('leaves out requests the person already decided, and counts what is waiting', async () => {
    expect(await w.platform.approvals.count(w.as(w.ngoA, amit))).toEqual({ waiting: 3 });
    expect(await w.platform.approvals.decide(w.as(w.ngoA, amit), req.g1!, 'approve')).toMatchObject({ status: 'pending', approvalsGiven: 1 });
    expect(await w.platform.approvals.count(w.as(w.ngoA, amit))).toEqual({ waiting: 2 });
    expect((await query(amit)).names).toEqual(['g2', 'c1']);
    expect((await w.platform.approvals.pendingForRecord(w.as(w.ngoA, amit), rec.g1!))!.canDecide).toBe(false);
    await expectCode(w.platform.approvals.decide(w.as(w.ngoA, amit), req.g1!, 'approve'), 'rule_violation');
    expect((await query(tara)).items.find((i) => i.id === req.g1)).toMatchObject({ approvalsGiven: 1, approvalsNeeded: 2 });
    expect(await w.platform.approvals.count(w.as(w.ngoA, tara))).toEqual({ waiting: 5 });
    expect(await w.platform.approvals.count(w.as(w.ngoA, olga))).toEqual({ waiting: 0 });
    expect(await w.platform.approvals.count(w.as(w.ngoB, tara))).toEqual({ waiting: 0 });
  });

  it('serves the query and count over HTTP', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/approvals/query',
      headers: headers(tara),
      payload: { search: 'g', filters: { type: ['grant'] }, sort: { field: 'record', dir: 'desc' }, limit: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 4, items: [{ recordNumber: 'GR/005' }, { recordNumber: 'GR/003' }] });
    const bad = await app.inject({ method: 'POST', url: '/api/approvals/query', headers: headers(tara), payload: { sort: { field: 'amount' } } });
    expect(bad.statusCode).toBe(422);
    expect((await app.inject({ method: 'GET', url: '/api/approvals/count', headers: headers(amit) })).json()).toEqual({ waiting: 2 });
    expect((await app.inject({ method: 'GET', url: '/api/approvals/inbox', headers: headers(amit) })).json()).toHaveLength(2);
    await app.close();
  });
});

describe('notifications', () => {
  it('pages newest first with a cursor, even when times are equal', async () => {
    for (let i = 1; i <= 5; i++) {
      await w.platform.notifications.notifyText(w.ngoA, { to: { users: [olga.id] }, subject: `N${i}`, body: 'hello' });
    }
    await w.platform.db.asSystem((tx) =>
      tx.query(`update notification set created_at = (select max(created_at) from notification where user_id = $1) where user_id = $1 and subject in ('N2', 'N3', 'N4')`, [olga.id]),
    );
    const ctx = w.as(w.ngoA, olga);
    const all = (await w.platform.notifications.inbox(ctx)).map((n) => n.id);
    expect(all).toHaveLength(5);
    const seen: string[] = [];
    let before: string | undefined;
    for (let pageNo = 0; pageNo < 3; pageNo++) {
      const page = await w.platform.notifications.inboxPage(ctx, { limit: 2, before });
      seen.push(...page.items.map((n) => n.id));
      before = page.next ?? undefined;
      expect(page.next === null).toBe(pageNo === 2);
    }
    expect(seen).toEqual(all);
    const times = (await w.platform.notifications.inbox(ctx)).map((n) => n.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    await expectCode(w.platform.notifications.inboxPage(ctx, { before: 'nope' }), 'validation_failed');

    const app = buildServer(w.platform, { devAuth: true });
    const headers = { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(olga) };
    const first = await app.inject({ method: 'GET', url: '/api/notifications?limit=3', headers });
    expect(first.json().map((n: { id: string }) => n.id)).toEqual(all.slice(0, 3));
    const next = first.headers['x-next-before'] as string;
    expect(next).toBe(all[2]);
    const second = await app.inject({ method: 'GET', url: `/api/notifications?limit=3&before=${next}`, headers });
    expect(second.json().map((n: { id: string }) => n.id)).toEqual(all.slice(3));
    expect(second.headers['x-next-before']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/notifications?before=x', headers })).statusCode).toBe(422);
    await app.close();
  });

  it('marks all of my unread notifications read, and only mine', async () => {
    await w.platform.notifications.notifyText(w.ngoA, { to: { users: [nina.id] }, subject: 'For Nina', body: 'hello' });
    const ctx = w.as(w.ngoA, olga);
    const [newest] = await w.platform.notifications.inbox(ctx);
    await w.platform.notifications.markRead(ctx, newest!.id);
    const readAt = (await w.platform.notifications.inbox(ctx))[0]!.readAt;
    const app = buildServer(w.platform, { devAuth: true });
    const res = await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: { 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(olga) } });
    await app.close();
    expect(res.json()).toEqual({ marked: 4 });
    expect(await w.platform.notifications.inbox(ctx, { unreadOnly: true })).toEqual([]);
    expect((await w.platform.notifications.inbox(ctx))[0]).toMatchObject({ id: newest!.id, readAt });
    expect(await w.platform.notifications.inbox(w.as(w.ngoA, nina), { unreadOnly: true })).toHaveLength(1);
    expect(await w.platform.notifications.markAllRead(ctx)).toBe(0);
  });
});
