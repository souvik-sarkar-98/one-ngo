import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { admin, clerk, completeIdentity, createWorld, expectCode, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
const ctx = (actor: Actor = admin) => w.as(w.ngoA, actor);
const headers = (actor: Actor = admin) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const donor = async (data: Record<string, unknown> = {}) => (await w.platform.records.create(ctx(), 'donor', { name: 'Meera', ...data })).record;
const donation = async (data: Record<string, unknown> = {}) =>
  (await w.platform.records.create(ctx(), 'donation', { donorName: 'Meera', amount: 500, ...data })).record;
const audit = (action: string) =>
  w.platform.db.asSystem((tx) => tx.query<{ entity_id: string }>(`select entity_id from audit_event where tenant_id = $1 and action = $2`, [w.ngoA, action]));
const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(ctx(), kind, body as never);
  await w.platform.definitions.publish(ctx(), kind, String(body.key));
};

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await completeIdentity(w, w.ngoA);
  app = buildServer(w.platform, { devAuth: true });
});
afterAll(() => w.close());

describe('deleting a record', () => {
  it('takes it out of every read and keeps it in the recycle bin, with the audit trail', async () => {
    const d = await donation({ donorName: 'Kabir' });
    await w.platform.records.deleteRecord(ctx(), d.id, d.version);
    await expectCode(w.platform.records.get(ctx(), d.id), 'not_found');
    expect((await w.platform.records.list(ctx(), 'donation')).map((r) => r.id)).not.toContain(d.id);

    const bin = await w.platform.records.listDeleted(ctx(), { typeKey: 'donation' });
    const entry = bin.items.find((i) => i.id === d.id);
    expect(entry).toMatchObject({ type: 'donation', typeLabel: 'Donation', number: d.number, title: 'Kabir', version: d.version + 1, deletedBy: admin.id });
    expect(bin.total).toBeGreaterThanOrEqual(1);
    expect((await audit('record.deleted')).map((a) => a.entity_id)).toContain(d.id);
  });

  it('is for administrators only', async () => {
    const d = await donation();
    await expectCode(w.platform.records.deleteRecord(ctx(clerk), d.id, d.version), 'forbidden');
    await expectCode(w.platform.records.listDeleted(ctx(clerk)), 'forbidden');
    await expectCode(w.platform.records.restoreRecord(ctx(clerk), d.id, d.version), 'forbidden');
    const scoped: Actor = { id: 'keeper', roles: [], permissions: ['admin:records'] };
    await w.platform.records.deleteRecord(ctx(scoped), d.id, d.version);
    expect((await w.platform.records.listDeleted(ctx(scoped))).items.map((i) => i.id)).toContain(d.id);
  });

  it('answers a stale version with a conflict and leaves the record alone', async () => {
    const d = await donation();
    await w.platform.records.update(ctx(), d.id, { data: { amount: 600 }, expectedVersion: d.version });
    await expectCode(w.platform.records.deleteRecord(ctx(), d.id, d.version), 'conflict');
    expect((await w.platform.records.get(ctx(), d.id)).data.amount).toBe(600);
  });

  it('is never visible to another organisation', async () => {
    const d = await donation();
    await w.platform.records.deleteRecord(ctx(), d.id, d.version);
    expect((await w.platform.records.listDeleted(w.as(w.ngoB))).items.map((i) => i.id)).not.toContain(d.id);
    await expectCode(w.platform.records.restoreRecord(w.as(w.ngoB), d.id, d.version + 1), 'not_found');
  });

  it('refuses a record with receipts and ledger entries', async () => {
    const d = await donation();
    await w.platform.records.transition(ctx(), d.id, 'markPaid', { expectedVersion: d.version, data: { method: 'cash', paidOn: today() } });
    const paid = await w.platform.records.get(ctx(), d.id);
    const refused = await expectCode(w.platform.records.deleteRecord(ctx(), d.id, paid.version), 'rule_violation');
    expect(refused.message).toMatch(/ledger entries/);
    expect((await w.platform.records.get(ctx(), d.id)).id).toBe(d.id);
  });

  it('refuses a record other records still refer to, until they are gone', async () => {
    const parent = await donor();
    const gift = await donation({ donor: parent.id });
    const refused = await expectCode(w.platform.records.deleteRecord(ctx(), parent.id, parent.version), 'rule_violation');
    expect(refused.message).toMatch(/1 Donation still refers to it through 'Donor'/);
    await w.platform.records.deleteRecord(ctx(), gift.id, gift.version);
    await w.platform.records.deleteRecord(ctx(), parent.id, parent.version);
    expect((await w.platform.records.listDeleted(ctx(), { typeKey: 'donor' })).items.map((i) => i.id)).toContain(parent.id);
  });
});

describe('restoring a record', () => {
  it('brings it back as it was, at the next version, and audits it', async () => {
    const d = await donation({ donorName: 'Ishaan', amount: 750 });
    await w.platform.records.deleteRecord(ctx(), d.id, d.version);
    const back = await w.platform.records.restoreRecord(ctx(), d.id, d.version + 1);
    expect(back).toMatchObject({ id: d.id, type: 'donation', number: d.number, version: d.version + 2 });
    expect(await w.platform.records.get(ctx(), d.id)).toMatchObject({ number: d.number, status: 'raised', data: { donorName: 'Ishaan', amount: 750 } });
    expect((await w.platform.records.listDeleted(ctx())).items.map((i) => i.id)).not.toContain(d.id);
    expect((await audit('record.restored')).map((a) => a.entity_id)).toContain(d.id);
  });

  it('answers a record that is not in the bin with not found, and a stale version with a conflict', async () => {
    const live = await donation();
    await expectCode(w.platform.records.restoreRecord(ctx(), live.id, live.version), 'not_found');
    await expectCode(w.platform.records.restoreRecord(ctx(), 'not-an-id', 1), 'not_found');
    await w.platform.records.deleteRecord(ctx(), live.id, live.version);
    await expectCode(w.platform.records.restoreRecord(ctx(), live.id, live.version), 'conflict');
  });

  it('refuses when a unique value was taken while it was in the bin', async () => {
    const first = await donor({ name: 'Original', pan: 'ABCDE1234F' });
    await w.platform.records.deleteRecord(ctx(), first.id, first.version);
    await donor({ name: 'Newcomer', pan: 'ABCDE1234F' });
    const refused = (await expectCode(w.platform.records.restoreRecord(ctx(), first.id, first.version + 1), 'validation_failed')) as Error & { issues: { path: string }[] };
    expect(refused.issues.map((i) => i.path)).toEqual(['/pan']);
    expect((await w.platform.records.listDeleted(ctx(), { typeKey: 'donor' })).items.map((i) => i.id)).toContain(first.id);
  });

  it('refuses while a record it refers to is still deleted', async () => {
    const parent = await donor({ name: 'Parent' });
    const gift = await donation({ donor: parent.id });
    await w.platform.records.deleteRecord(ctx(), gift.id, gift.version);
    await w.platform.records.deleteRecord(ctx(), parent.id, parent.version);
    await expectCode(w.platform.records.restoreRecord(ctx(), gift.id, gift.version + 1), 'rule_violation');
    await w.platform.records.restoreRecord(ctx(), parent.id, parent.version + 1);
    await w.platform.records.restoreRecord(ctx(), gift.id, gift.version + 1);
    expect((await w.platform.records.get(ctx(), gift.id)).data.donor).toBe(parent.id);
  });
});

describe('the recycle bin list', () => {
  it('filters by type and search text, and pages', async () => {
    const a = await donor({ name: 'Zebra Foundation' });
    const b = await donor({ name: 'Quokka Trust' });
    for (const r of [a, b]) await w.platform.records.deleteRecord(ctx(), r.id, r.version);
    const hits = (q: Record<string, unknown>) => w.platform.records.listDeleted(ctx(), q);
    expect((await hits({ typeKey: 'donor', search: 'zebra' })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await hits({ typeKey: 'donor', search: 'no-such-name' })).total).toBe(0);
    expect((await hits({ typeKey: 'donor', search: '100%_' })).total).toBe(0);
    expect((await hits({ typeKey: 'donor', search: a.number! })).items.map((i) => i.id)).toEqual([a.id]);
    const page = await hits({ typeKey: 'donor', limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect((await hits({ typeKey: 'donor', limit: 1, offset: 1 })).items[0]!.id).not.toBe(page.items[0]!.id);
  });
});

describe('over HTTP', () => {
  it('deletes with ?version=, lists, and restores', async () => {
    const d = await donation({ donorName: 'Tara' });
    const del = await app.inject({ method: 'DELETE', url: `/api/records/donation/${d.id}?version=${d.version}`, headers: headers() });
    expect(del.statusCode, del.body).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/api/admin/recycle-bin?type=donation&q=Tara', headers: headers() });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ total: 1, items: [{ id: d.id, typeLabel: 'Donation', title: 'Tara', version: d.version + 1, deletedBy: admin.id }] });

    const back = await app.inject({ method: 'POST', url: `/api/admin/recycle-bin/${d.id}/restore`, headers: headers(), payload: { expectedVersion: d.version + 1 } });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ id: d.id, type: 'donation', version: d.version + 2 });
    expect((await app.inject({ method: 'GET', url: `/api/records/donation/${d.id}`, headers: headers() })).statusCode).toBe(200);
  });

  it('refuses anyone without the permission, and a delete with no version', async () => {
    const d = await donation();
    const refused = await app.inject({ method: 'DELETE', url: `/api/records/donation/${d.id}?version=${d.version}`, headers: headers(clerk) });
    expect(refused.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admin/recycle-bin', headers: headers(clerk) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/records/donation/${d.id}`, headers: headers() })).statusCode).toBe(400);
  });

  it('tells a person whether they can open the bin', async () => {
    const me = async (actor: Actor) => (await app.inject({ method: 'GET', url: '/api/people/me', headers: headers(actor) })).json() as { capabilities?: { recordBin?: boolean } };
    expect((await me(admin)).capabilities?.recordBin).toBe(true);
    expect((await me(clerk)).capabilities?.recordBin).toBe(false);
  });
});

describe('archiving a connector', () => {
  const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: Record<string, unknown>, actor: Actor = admin) =>
    app.inject({ method, url, headers: headers(actor), ...(payload ? { payload } : {}) });
  const hook = (key: string) =>
    call('PUT', `/api/admin/connectors/${key}`, { kind: 'webhook', config: { url: `https://${key}.test/hooks` }, secrets: { signingSecret: 'sign-1' }, enabled: true });
  const row = async (key: string) => ((await call('GET', '/api/admin/connectors')).json() as { key: string; archived: boolean; enabled: boolean }[]).find((c) => c.key === key);

  it('switches it off, keeps it, refuses edits, and restores it switched off', async () => {
    expect((await hook('old-crm')).statusCode).toBe(200);
    const archived = await call('POST', '/api/admin/connectors/old-crm/archive');
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toMatchObject({ key: 'old-crm', archived: true, enabled: false });
    expect(await row('old-crm')).toMatchObject({ archived: true, enabled: false });

    const edit = await call('PUT', '/api/admin/connectors/old-crm', { enabled: true });
    expect(edit.statusCode).toBe(422);
    expect(edit.json()).toMatchObject({ code: 'rule_violation' });
    expect((await call('POST', '/api/admin/connectors/old-crm/archive')).statusCode).toBe(200);

    const restored = await call('POST', '/api/admin/connectors/old-crm/restore');
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ archived: false, enabled: false, configured: true });
    expect((await call('PUT', '/api/admin/connectors/old-crm', { enabled: true })).statusCode).toBe(200);
    expect((await audit('connector.archived')).length).toBeGreaterThan(0);
    expect((await audit('connector.restored')).length).toBeGreaterThan(0);
  });

  it('refuses while a published definition uses it', async () => {
    expect((await hook('live-crm')).statusCode).toBe(200);
    await publish('action', {
      key: 'tellLiveCrm',
      recordType: 'donation',
      label: 'Tell the CRM',
      placement: ['panel'],
      steps: [{ type: 'webhook', connector: 'live-crm', body: { amount: 'record.amount' } }],
    });
    const refused = await call('POST', '/api/admin/connectors/live-crm/archive');
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'rule_violation' });
    expect(await row('live-crm')).toMatchObject({ archived: false, enabled: true });
  });

  it('refuses a connector that does not exist and anyone without admin:connectors', async () => {
    expect((await call('POST', '/api/admin/connectors/nothing/archive')).statusCode).toBe(404);
    expect((await call('POST', '/api/admin/connectors/old-crm/archive', undefined, clerk)).statusCode).toBe(403);
    expect((await call('POST', '/api/admin/connectors/old-crm/restore', undefined, clerk)).statusCode).toBe(403);
  });
});
