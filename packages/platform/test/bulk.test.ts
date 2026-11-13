import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BulkResult } from '../src/application/records/bulk-service.js';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { bulkPermissionsByType } from '../src/runtime/definitions/record-permissions.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { admin, createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;

const BASE = ['record:case:read', 'record:case:create', 'record:case:update', 'record:case:transition:*', 'record:case:action:*', 'record:case:export'];
const people: Record<string, Actor> = {};

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
async function person(name: string, extra: string[] = [], roles: string[] = []): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name.toLowerCase().replace(/ /g, '.')}@example.org`, name]),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    for (const r of roles) await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [w.ngoA, u!.id, r]);
    // Bulk jobs act with the person's current roles (S4-12), so the permissions must be held through a role.
    const held = `held-${u!.id}`;
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, $2, $2, $3::text[])`, [w.ngoA, held, [...BASE, ...extra]]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [w.ngoA, u!.id, held]);
  });
  return { id: u!.id, roles, permissions: [...BASE, ...extra] };
}
const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const bulk = (actor: Actor, payload: Record<string, unknown>, type = 'case') =>
  app.inject({ method: 'POST', url: `/api/records/${type}/bulk`, headers: headers(actor), payload });
const newCase = async (actor: Actor, title: string, data: Record<string, unknown> = {}) =>
  (await w.platform.records.create(w.as(w.ngoA, actor), 'case', { title, ...data })).record;
const record = (id: string) => w.platform.records.get(w.as(w.ngoA), id);

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, bulkInlineRecords: 3, bulkMaxRecords: 6 });
  app = buildServer(w.platform, { devAuth: true });
  await w.platform.db.asSystem((tx) => tx.query(`insert into role (tenant_id, key, label) values ($1, 'approvers', 'Approvers'), ($1, 'auditors', 'Auditors')`, [w.ngoA]));
  await publish('recordType', {
    key: 'case',
    label: 'Case',
    titleField: 'title',
    visibility: 'restricted',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true, searchable: true },
      { key: 'lead', label: 'Lead', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'text', editableWhen: 'record.lead == user.id' },
      { key: 'stamp', label: 'Stamp', type: 'text' },
    ],
  });
  await publish('workflow', {
    key: 'case',
    recordType: 'case',
    initial: 'open',
    states: [
      { key: 'open', label: 'Open' },
      { key: 'held', label: 'On hold' },
      { key: 'approved', label: 'Approved' },
    ],
    transitions: [
      { key: 'hold', label: 'Hold', from: ['open'], to: 'held' },
      { key: 'approve', label: 'Approve', from: ['open', 'held'], to: 'approved', approval: { roles: ['approvers'] } },
    ],
  });
  await publish('action', {
    key: 'stamp',
    recordType: 'case',
    label: 'Stamp',
    placement: ['panel', 'bulk'],
    form: { fields: [{ key: 'by', label: 'By', type: 'text', required: true }] },
    steps: [{ type: 'setFields', values: { stamp: "'by ' + input.by" } }],
  });
  await publish('action', { key: 'single', recordType: 'case', label: 'Single', placement: ['panel'], steps: [{ type: 'setFields', values: { stamp: "'one'" } }] });
  await publish('recordType', { key: 'memo', label: 'Memo', titleField: 'title', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }] });

  people.worker = await person('Wanda Worker', ['record:case:bulk']);
  people.plain = await person('Paul Plain');
  people.other = await person('Omar Other', ['record:case:bulk']);
  people.friend = await person('Farah Friend');
});
afterAll(async () => {
  await app.close();
  await w.close();
});

describe('bulk edit', () => {
  it('saves the records the person may change and reports the rest, each at its current version', async () => {
    const { worker, other } = people;
    const led = await newCase(worker!, 'Led by me', { lead: worker!.id });
    const notLed = await newCase(worker!, 'Led by someone else', { lead: other!.id });
    const hidden = await newCase(other!, 'Not mine', { lead: worker!.id });
    await w.platform.records.update(w.as(w.ngoA), led.id, { data: { stamp: 'touched' }, expectedVersion: led.version });

    const res = await bulk(worker!, { ids: [led.id, notLed.id, hidden.id], operation: { type: 'edit', values: { notes: 'Checked' } } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: BulkResult[]; done: number; failed: number };
    expect(body).toMatchObject({ done: 1, failed: 2 });
    expect(body.results).toEqual([
      { id: led.id, ok: true },
      { id: notLed.id, ok: false, message: 'Some fields cannot be changed now. notes: cannot be changed now.' },
      { id: hidden.id, ok: false, message: 'Record not found.' },
    ]);
    expect(await record(led.id)).toMatchObject({ version: led.version + 2, data: { notes: 'Checked', stamp: 'touched' } });
    expect((await record(notLed.id)).version).toBe(notLed.version);
    expect((await record(hidden.id)).data.notes).toBeUndefined();
  });

  it('needs record:<type>:bulk as well as the per-record permission', async () => {
    const { worker, plain } = people;
    const mine = await newCase(plain!, 'Plain case');
    expect((await bulk(plain!, { ids: [mine.id], operation: { type: 'edit', values: { stamp: 'x' } } })).statusCode).toBe(403);
    const noUpdate = { ...worker!, permissions: worker!.permissions.filter((p) => p !== 'record:case:update') };
    const own = await newCase(worker!, 'Worker case');
    const res = (await bulk(noUpdate, { ids: [own.id], operation: { type: 'edit', values: { stamp: 'x' } } })).json() as { results: BulkResult[] };
    expect(res.results).toEqual([{ id: own.id, ok: false, message: 'You do not have permission to do this.' }]);
    expect((await record(own.id)).data.stamp).toBeUndefined();
    expect(bulkPermissionsByType([{ key: 'memo' }, { key: 'case' }])).toEqual({ case: 'record:case:bulk', memo: 'record:memo:bulk' });
  });

  it('refuses a request without a selection, an empty edit or an unknown operation', async () => {
    const { worker } = people;
    const one = await newCase(worker!, 'Any');
    expect((await bulk(worker!, { operation: { type: 'edit', values: { stamp: 'x' } } })).statusCode).toBe(400);
    expect((await bulk(worker!, { ids: [], operation: { type: 'edit', values: { stamp: 'x' } } })).statusCode).toBe(422);
    expect((await bulk(worker!, { ids: [one.id], operation: { type: 'edit', values: {} } })).statusCode).toBe(422);
    const unknown = await bulk(worker!, { ids: [one.id], operation: { type: 'delete' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().issues).toEqual([{ path: '/operation/type', message: 'is not a known kind' }]);
  });
});

describe('selection by query', () => {
  it('covers only the records the person can see', async () => {
    const { worker, other } = people;
    const mine = [await newCase(worker!, 'Query alpha'), await newCase(worker!, 'Query beta')];
    await newCase(other!, 'Query gamma');
    const res = await bulk(worker!, { query: { search: 'query' }, operation: { type: 'edit', values: { stamp: 'q' } } });
    const body = res.json() as { results: BulkResult[]; done: number };
    expect(body.results.map((r) => r.id).sort()).toEqual(mine.map((r) => r.id).sort());
    expect(body.done).toBe(2);
  });

  it('refuses more than the limit, saying how many matched', async () => {
    for (let i = 0; i < 7; i++) await w.platform.records.create(w.as(w.ngoA), 'memo', { title: `Memo ${i}` });
    const many = await bulk(admin, { query: {}, operation: { type: 'edit', values: { title: 'x' } } }, 'memo');
    expect(many.statusCode).toBe(422);
    expect(many.json().message).toContain('7 records match');
    const ids = (await w.platform.records.query(w.as(w.ngoA), 'memo', { limit: 7 })).items.map((r) => r.id);
    const picked = await bulk(admin, { ids, operation: { type: 'edit', values: { title: 'x' } } }, 'memo');
    expect(picked.statusCode).toBe(422);
    expect(picked.json().message).toContain('7 records are selected');
    const narrowed = await bulk(admin, { query: { search: 'memo 1' }, operation: { type: 'edit', values: { title: 'Memo one' } } }, 'memo');
    expect(narrowed.statusCode).toBe(200);
    expect(narrowed.json()).toMatchObject({ done: 1, failed: 0 });
    expect((await w.platform.records.query(w.as(w.ngoA), 'memo', { search: 'memo one' })).total).toBe(1);
  });
});

describe('bulk step', () => {
  it('creates one approval request per record for a step that needs approval', async () => {
    const { worker } = people;
    const cases = [await newCase(worker!, 'Approve 1'), await newCase(worker!, 'Approve 2'), await newCase(worker!, 'Approve 3')];
    const res = (await bulk(worker!, { ids: cases.map((c) => c.id), operation: { type: 'step', step: 'approve' } })).json() as { results: BulkResult[]; done: number };
    expect(res.done).toBe(3);
    const requestIds = res.results.map((r) => r.approvalRequestId);
    expect(new Set(requestIds).size).toBe(3);
    const rows = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ id: string; record_id: string }>(`select id, record_id from approval_request where record_id = any($1::uuid[])`, [cases.map((c) => c.id)]),
    );
    expect(rows.map((r) => r.record_id).sort()).toEqual(cases.map((c) => c.id).sort());
    expect(rows.map((r) => r.id).sort()).toEqual([...requestIds].sort());
    for (const c of cases) expect((await record(c.id)).status).toBe('open');

    const again = (await bulk(worker!, { ids: [cases[0]!.id], operation: { type: 'step', step: 'approve' } })).json() as { results: BulkResult[] };
    expect(again.results[0]).toEqual({ id: cases[0]!.id, ok: false, message: 'This record already has a step waiting for approval.' });
  });

  it('refuses an unknown step before touching any record', async () => {
    const one = await newCase(people.worker!, 'Unknown step');
    expect((await bulk(people.worker!, { ids: [one.id], operation: { type: 'step', step: 'teleport' } })).statusCode).toBe(404);
  });

  it('runs larger selections as an exclusive bulk job with per-record items, progress and a finished notice', async () => {
    const { worker } = people;
    const cases: string[] = [];
    for (let i = 0; i < 5; i++) cases.push((await newCase(worker!, `Job ${i}`)).id);
    const held = await w.platform.records.get(w.as(w.ngoA), cases[2]!);
    await w.platform.records.transition(w.as(w.ngoA, worker!), held.id, 'hold', { expectedVersion: held.version });

    const res = await bulk(worker!, { ids: cases, operation: { type: 'step', step: 'hold' } });
    expect(res.statusCode).toBe(202);
    const { jobId, total } = res.json() as { jobId: string; total: number };
    expect(total).toBe(5);
    const queued = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: headers(worker!) })).json();
    expect(queued).toMatchObject({ kind: 'bulk', status: 'queued', progress: 0, total: 5 });
    for (const id of cases) expect((await record(id)).status).toBe(id === held.id ? 'held' : 'open');

    await w.platform.jobs.runOnce();
    const finished = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: headers(worker!) })).json();
    expect(finished).toMatchObject({ status: 'done', progress: 5, total: 5, result: { recordType: 'case', operation: 'step', done: 4, failed: 1 } });
    const failed = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/items?status=failed`, headers: headers(worker!) })).json();
    expect(failed.items).toEqual([{ seq: 3, status: 'failed', recordId: held.id, message: "'Hold' is not available from the current status." }]);
    for (const id of cases) expect((await record(id)).status).toBe('held');

    const notice = (await w.platform.notifications.inbox(w.as(w.ngoA, worker!))).find((n) => n.subject === 'Bulk step finished');
    expect(notice).toMatchObject({ body: 'Bulk step finished: 4 done, 1 failed.', link: `/records/case?bulk=${jobId}` });
  });

  it('creates one approval request per record in the job path too', async () => {
    const { worker } = people;
    const cases: string[] = [];
    for (let i = 0; i < 4; i++) cases.push((await newCase(worker!, `Job approve ${i}`)).id);
    const { jobId } = (await bulk(worker!, { ids: cases, operation: { type: 'step', step: 'approve' } })).json() as { jobId: string };
    await w.platform.jobs.runOnce();
    const items = (await w.platform.jobs.items(w.as(w.ngoA, worker!), jobId)).items;
    expect(items.map((i) => i.status)).toEqual(['done', 'done', 'done', 'done']);
    const requested = items.map((i) => (i.data as { approvalRequestId: string }).approvalRequestId);
    const [n] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from approval_request where id = any($1::uuid[]) and record_id = any($2::uuid[])`, [requested, cases]),
    );
    expect(n!.n).toBe(4);
  });
});

describe('bulk action, share and export', () => {
  it('runs an action placed for bulk with input collected once, and refuses other actions and bad input', async () => {
    const { worker } = people;
    const cases = [await newCase(worker!, 'Stamp 1'), await newCase(worker!, 'Stamp 2')];
    const res = (await bulk(worker!, { ids: cases.map((c) => c.id), operation: { type: 'action', action: 'stamp', input: { by: 'Asha' } } })).json() as { results: BulkResult[] };
    expect(res.results).toEqual(cases.map((c) => ({ id: c.id, ok: true, message: 'Stamp: done.' })));
    for (const c of cases) expect((await record(c.id)).data.stamp).toBe('by Asha');

    expect((await bulk(worker!, { ids: [cases[0]!.id], operation: { type: 'action', action: 'stamp', input: {} } })).statusCode).toBe(422);
    const panelOnly = await bulk(worker!, { ids: [cases[0]!.id], operation: { type: 'action', action: 'single' } });
    expect(panelOnly.json()).toMatchObject({ code: 'rule_violation' });
    await expectCode(
      w.platform.bulk.run(w.as(w.ngoA, { ...worker!, permissions: worker!.permissions.filter((p) => p !== 'record:case:action:*') }), 'case', { ids: [cases[0]!.id] }, { type: 'action', action: 'stamp', input: { by: 'x' } }),
      'forbidden',
    );
  });

  it('shares the records the person may share and reports the others', async () => {
    const { worker, other, friend } = people;
    const own = await newCase(worker!, 'Share mine');
    const theirs = await newCase(other!, 'Share theirs');
    await w.platform.shares.share(w.as(w.ngoA, other!), 'case', theirs.id, { principalKind: 'user', principal: worker!.id, access: 'edit' });

    const res = (await bulk(worker!, { ids: [own.id, theirs.id], operation: { type: 'share', principalKind: 'user', principal: friend!.id, access: 'read' } })).json() as {
      results: BulkResult[];
    };
    expect(res.results).toEqual([
      { id: own.id, ok: true },
      { id: theirs.id, ok: false, message: 'Only its creator or people allowed to share can share this record.' },
    ]);
    expect((await w.platform.records.get(w.as(w.ngoA, friend!), own.id)).id).toBe(own.id);
    await expectCode(w.platform.records.get(w.as(w.ngoA, friend!), theirs.id), 'not_found');

    const bad = await bulk(worker!, { ids: [own.id], operation: { type: 'share', principalKind: 'team', principal: 'x', access: 'read' } });
    expect(bad.statusCode).toBe(400);
    const past = await bulk(worker!, { ids: [own.id], operation: { type: 'share', principalKind: 'user', principal: friend!.id, access: 'read', expiresAt: '2000-01-01' } });
    expect(past.statusCode).toBe(422);
    const memo = await w.platform.records.create(w.as(w.ngoA), 'memo', { title: 'Open memo' });
    expect((await bulk(admin, { ids: [memo.record.id], operation: { type: 'share', principalKind: 'role', principal: 'auditors', access: 'read' } }, 'memo')).json()).toMatchObject({
      code: 'rule_violation',
    });
  });

  it('exports exactly the selected records the person can see', async () => {
    const { worker, other } = people;
    const picked = [await newCase(worker!, 'Export one'), await newCase(worker!, 'Export two')];
    await newCase(worker!, 'Export not picked');
    const hidden = await newCase(other!, 'Export hidden');
    const res = await bulk(worker!, { ids: [...picked.map((c) => c.id), hidden.id], operation: { type: 'export' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).map((l) => l.split(',')[1]).sort()).toEqual(['Export one', 'Export two']);

    const noExport = { ...worker!, permissions: worker!.permissions.filter((p) => p !== 'record:case:export') };
    expect((await bulk(noExport, { ids: [picked[0]!.id], operation: { type: 'export' } })).statusCode).toBe(403);
  });
});
