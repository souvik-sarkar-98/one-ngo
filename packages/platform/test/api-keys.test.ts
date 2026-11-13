import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { sha256 } from '@onengo/kernel/crypto';
import { applyRetention } from '../src/infrastructure/postgres/retention.js';
import { admin, clerk, completeIdentity, createWorld, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await completeIdentity(w, w.ngoA);
  app = buildServer(w.platform, { devAuth: true });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

const dev = (tenant: string, actor = admin) => ({ 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) });
const key = (token: string) => ({ authorization: `ApiKey ${token}` });

async function newKey(name: string, role: string, tenant = w.ngoA): Promise<{ id: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/api-keys', headers: dev(tenant), payload: { name, role } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function auditActors(entityId: string): Promise<string[]> {
  const rows = await w.platform.db.asSystem((tx) =>
    tx.query<{ actor_id: string }>(`select actor_id from audit_event where entity_id = $1 order by id`, [entityId]),
  );
  return rows.map((r) => r.actor_id);
}

describe('API keys', () => {
  it('creates a key whose secret is shown once and stored only as a hash', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/api-keys', headers: dev(w.ngoA), payload: { name: 'Website', role: 'finance' } });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({ name: 'Website', role: 'finance', createdBy: admin.id, lastUsedAt: null, revokedAt: null });
    expect(created.token).toMatch(new RegExp(`^${created.id}\\.[A-Za-z0-9_-]{43}$`));
    const secret = created.token.split('.')[1];

    const [stored] = await w.platform.db.asSystem((tx) => tx.query<{ secret_hash: string }>(`select secret_hash from api_key where id = $1`, [created.id]));
    expect(stored!.secret_hash).toBe(sha256(secret));
    expect(stored!.secret_hash).not.toContain(secret);

    const list = await app.inject({ method: 'GET', url: '/api/admin/api-keys', headers: dev(w.ngoA) });
    expect(list.statusCode).toBe(200);
    const listed = list.json().find((k: { id: string }) => k.id === created.id);
    expect(listed).toMatchObject({ name: 'Website', role: 'finance' });
    expect(JSON.stringify(list.json())).not.toContain(secret);
    expect(listed).not.toHaveProperty('token');

    const other = await app.inject({ method: 'GET', url: '/api/admin/api-keys', headers: dev(w.ngoB) });
    expect(other.json().some((k: { id: string }) => k.id === created.id)).toBe(false);
  });

  it('needs admin:api-keys, a known role and a free name', async () => {
    for (const req of [
      { method: 'GET' as const, url: '/api/admin/api-keys' },
      { method: 'POST' as const, url: '/api/admin/api-keys', payload: { name: 'Clerk key', role: 'finance' } },
      { method: 'DELETE' as const, url: '/api/admin/api-keys/00000000-0000-0000-0000-000000000000' },
    ]) {
      expect((await app.inject({ ...req, headers: dev(w.ngoA, clerk) })).statusCode).toBe(403);
    }
    const unknownRole = await app.inject({ method: 'POST', url: '/api/admin/api-keys', headers: dev(w.ngoA), payload: { name: 'Nope', role: 'ghost' } });
    expect(unknownRole.statusCode).toBe(422);
    const noName = await app.inject({ method: 'POST', url: '/api/admin/api-keys', headers: dev(w.ngoA), payload: { name: ' ', role: 'finance' } });
    expect(noName.statusCode).toBe(422);
    await newKey('Twin', 'viewer');
    const twin = await app.inject({ method: 'POST', url: '/api/admin/api-keys', headers: dev(w.ngoA), payload: { name: 'twin', role: 'finance' } });
    expect(twin.statusCode).toBe(409);
  });

  it('signs in with a valid key and refuses a wrong secret, an unknown key or a malformed one', async () => {
    const { id, token } = await newKey('Reader', 'viewer');
    const ok = await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(token) });
    expect(ok.statusCode).toBe(200);
    const [used] = await w.platform.db.asSystem((tx) => tx.query<{ last_used_at: unknown }>(`select last_used_at from api_key where id = $1`, [id]));
    expect(used!.last_used_at).not.toBeNull();

    const wrong = await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(`${id}.${'x'.repeat(43)}`) });
    expect(wrong.statusCode).toBe(403);
    const unknown = await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(`00000000-0000-4000-8000-000000000000.${token.split('.')[1]}`) });
    expect(unknown.statusCode).toBe(403);
    for (const bad of ['', 'abc', id, `${id}.`, `not-a-uuid.${token.split('.')[1]}`]) {
      expect((await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(bad) })).statusCode).toBe(403);
    }
  });

  it("acts with the key's role only", async () => {
    const { token } = await newKey('Viewer bot', 'viewer');
    const create = await app.inject({ method: 'POST', url: '/api/records/donation', headers: key(token), payload: { donorName: 'Blocked', amount: 10 } });
    expect(create.statusCode).toBe(403);
    const keys = await app.inject({ method: 'GET', url: '/api/admin/api-keys', headers: key(token) });
    expect(keys.statusCode).toBe(403);
  });

  it('stops working once revoked, and the name can be used again', async () => {
    const { id, token } = await newKey('Old site', 'finance');
    expect((await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(token) })).statusCode).toBe(200);

    const revoke = await app.inject({ method: 'DELETE', url: `/api/admin/api-keys/${id}`, headers: dev(w.ngoA) });
    expect(revoke.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/api-keys/${id}`, headers: dev(w.ngoA) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/api-keys/${id}`, headers: dev(w.ngoB) })).statusCode).toBe(404);

    const list = (await app.inject({ method: 'GET', url: '/api/admin/api-keys', headers: dev(w.ngoA) })).json();
    expect(list.find((k: { id: string }) => k.id === id).revokedAt).not.toBeNull();
    expect(await auditActors(id)).toEqual([admin.id, admin.id]);
    await newKey('Old site', 'finance');
  });

  it("limits each key to the organisation's requests per minute", async () => {
    await w.platform.db.withTenant(w.ngoB, (tx) =>
      tx.query(`insert into tenant_setting (tenant_id, key, value) values (app_tenant(), 'api.rateLimitPerMinute', '3')`),
    );
    const first = await newKey('Busy', 'viewer', w.ngoB);
    const second = await newKey('Quiet', 'viewer', w.ngoB);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(first.token) })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const limited = await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(first.token) });
    expect(limited.json()).toMatchObject({ code: 'rate_limited' });
    expect((await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(second.token) })).statusCode).toBe(200);

    const roomy = await newKey('Roomy', 'viewer');
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: '/api/records/donation', headers: key(roomy.token) })).statusCode).toBe(200);
  });

  it('records the key as actor api:<name> in audit and on the record', async () => {
    const { token } = await newKey('Payments sync', 'finance');
    const res = await app.inject({ method: 'POST', url: '/api/records/donation', headers: key(token), payload: { donorName: 'Via API', amount: 500 } });
    expect(res.statusCode).toBe(201);
    const id = res.json().record.id;
    const paid = await app.inject({
      method: 'POST',
      url: `/api/records/donation/${id}/transitions/markPaid`,
      headers: key(token),
      payload: { expectedVersion: 1, data: { method: 'cash', paidOn: today() } },
    });
    expect(paid.statusCode).toBe(200);
    expect(new Set(await auditActors(id))).toEqual(new Set(['api:Payments sync']));
    const [row] = await w.platform.db.asSystem((tx) => tx.query<{ created_by: string; updated_by: string }>(`select created_by, updated_by from record where id = $1`, [id]));
    expect(row).toEqual({ created_by: 'api:Payments sync', updated_by: 'api:Payments sync' });
  });
});

describe('Idempotency-Key', () => {
  let token: string;
  let otherToken: string;
  beforeAll(async () => {
    token = (await newKey('Importer', 'finance')).token;
    otherToken = (await newKey('Importer two', 'finance')).token;
  });

  const count = async (donorName: string) => {
    const [row] = await w.platform.db.asSystem((tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from record where tenant_id = $1 and data ->> 'donorName' = $2`, [w.ngoA, donorName]),
    );
    return row!.n;
  };

  it('replays the first response to a repeated create without creating again', async () => {
    const send = () =>
      app.inject({ method: 'POST', url: '/api/records/donation', headers: { ...key(token), 'idempotency-key': 'create-1' }, payload: { donorName: 'Once only', amount: 100 } });
    const first = await send();
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const again = await send();
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await count('Once only')).toBe(1);
  });

  it('refuses the same key with a different body', async () => {
    const headers = { ...key(token), 'idempotency-key': 'create-2' };
    expect((await app.inject({ method: 'POST', url: '/api/records/donation', headers, payload: { donorName: 'First body', amount: 100 } })).statusCode).toBe(201);
    const changed = await app.inject({ method: 'POST', url: '/api/records/donation', headers, payload: { donorName: 'First body', amount: 200 } });
    expect(changed.statusCode).toBe(422);
    expect(changed.json().message).toMatch(/different request/);
    const elsewhere = await app.inject({ method: 'POST', url: '/api/records/donor', headers, payload: { donorName: 'First body', amount: 100 } });
    expect(elsewhere.statusCode).toBe(422);
    expect(await count('First body')).toBe(1);
  });

  it('keeps keys of different actors apart', async () => {
    const payload = { donorName: 'Two actors', amount: 100 };
    const a = await app.inject({ method: 'POST', url: '/api/records/donation', headers: { ...key(token), 'idempotency-key': 'shared' }, payload });
    const b = await app.inject({ method: 'POST', url: '/api/records/donation', headers: { ...key(otherToken), 'idempotency-key': 'shared' }, payload });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(a.json().record.id).not.toBe(b.json().record.id);
    expect(await count('Two actors')).toBe(2);
  });

  it('replays update and step requests', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/records/donation', headers: key(token), payload: { donorName: 'Steps', amount: 300 } });
    const id = created.json().record.id;

    const patch = () =>
      app.inject({ method: 'PATCH', url: `/api/records/donation/${id}`, headers: { ...key(token), 'idempotency-key': 'patch-1' }, payload: { expectedVersion: 1, data: { notes: 'first' } } });
    const p1 = await patch();
    expect(p1.statusCode).toBe(200);
    const p2 = await patch();
    expect(p2.statusCode).toBe(200);
    expect(p2.json()).toEqual(p1.json());

    const step = () =>
      app.inject({
        method: 'POST',
        url: `/api/records/donation/${id}/transitions/markPaid`,
        headers: { ...key(token), 'idempotency-key': 'step-1' },
        payload: { expectedVersion: 2, data: { method: 'cash', paidOn: today() } },
      });
    const s1 = await step();
    expect(s1.statusCode).toBe(200);
    expect(s1.json().receipts).toHaveLength(1);
    const s2 = await step();
    expect(s2.statusCode).toBe(200);
    expect(s2.json()).toEqual(s1.json());
    const read = await app.inject({ method: 'GET', url: `/api/records/donation/${id}`, headers: key(token) });
    expect(read.json()).toMatchObject({ status: 'paid', version: 3 });
  });

  it('does not keep failed requests, so they can be corrected and retried', async () => {
    const headers = { ...key(token), 'idempotency-key': 'retry-1' };
    const bad = await app.inject({ method: 'POST', url: '/api/records/donation', headers, payload: { amount: 100 } });
    expect(bad.statusCode).toBe(422);
    const fixed = await app.inject({ method: 'POST', url: '/api/records/donation', headers, payload: { donorName: 'Fixed', amount: 100 } });
    expect(fixed.statusCode).toBe(201);
    expect(fixed.headers['idempotent-replayed']).toBeUndefined();
  });

  it('forgets keys after 24 hours', async () => {
    const send = () =>
      app.inject({ method: 'POST', url: '/api/records/donation', headers: { ...key(token), 'idempotency-key': 'old-1' }, payload: { donorName: 'Day old', amount: 100 } });
    expect((await send()).statusCode).toBe(201);
    await w.platform.db.asSystem((tx) => tx.query(`update idempotency_key set created_at = now() - interval '25 hours' where key = 'old-1'`));
    const later = await send();
    expect(later.statusCode).toBe(201);
    expect(later.headers['idempotent-replayed']).toBeUndefined();
    expect(await count('Day old')).toBe(2);

    await w.platform.db.asSystem((tx) => tx.query(`update idempotency_key set created_at = now() - interval '25 hours' where key = 'old-1'`));
    const result = await applyRetention(w.platform.db);
    expect(result.deleted.idempotency_key).toBeGreaterThanOrEqual(1);
    const left = await w.platform.db.asSystem((tx) => tx.query(`select 1 from idempotency_key where key = 'old-1'`));
    expect(left).toHaveLength(0);
  });

  it('rejects an unusable key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/records/donation', headers: { ...key(token), 'idempotency-key': 'x'.repeat(256) }, payload: { donorName: 'Long', amount: 1 } });
    expect(res.statusCode).toBe(422);
  });
});

describe('OpenAPI document', () => {
  type Doc = {
    openapi: string;
    info: { title: string; version: string };
    paths: Record<string, Record<string, { operationId?: string; parameters?: unknown[]; requestBody?: unknown }>>;
    components: { schemas: Record<string, { properties: Record<string, { type?: unknown; enum?: unknown[]; format?: string }>; required?: string[] }> };
  };
  const doc = async (headers: Record<string, string>): Promise<Doc> => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json', headers });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it('describes the Donations module: schemas, the markPaid step and the actions', async () => {
    const { token } = await newKey('Docs', 'finance');
    const d = await doc(key(token));
    expect(d.openapi).toBe('3.1.0');
    expect(d.info.title).toBe('Asha Trust API');

    const donation = d.components.schemas.donation!;
    expect(Object.keys(donation.properties)).toEqual(
      expect.arrayContaining(['donor', 'donorName', 'donorEmail', 'amount', 'method', 'paidOn', 'reference', 'fee', 'netAmount', 'notes']),
    );
    expect(donation.required).toEqual(['donorName', 'amount']);
    expect(donation.properties.donor).toMatchObject({ type: 'string', format: 'uuid', 'x-reference-type': 'donor' });
    expect(donation.properties.method!.enum).toEqual(['upi', 'cash', 'bank_transfer', 'cheque', 'online']);
    expect(donation.properties.netAmount).toMatchObject({ readOnly: true });
    expect(d.components.schemas['donation.record']!.properties.status!.enum).toEqual(['raised', 'paid', 'cancelled', null]);

    const donor = d.components.schemas.donor!;
    expect(Object.keys(donor.properties)).toEqual(expect.arrayContaining(['name', 'email', 'phone', 'pan', 'totalGiven', 'donationCount']));
    expect(donor.required).toEqual(['name']);
    expect(donor.properties.totalGiven).toMatchObject({ readOnly: true });

    expect(Object.keys(d.paths['/api/records/donation']!)).toEqual(expect.arrayContaining(['get', 'post']));
    expect(Object.keys(d.paths['/api/records/donation/{id}']!)).toEqual(expect.arrayContaining(['get', 'patch']));
    const markPaid = d.paths['/api/records/donation/{id}/transitions/markPaid']!.post!;
    expect(markPaid.operationId).toBe('donation_step_markPaid');
    expect(markPaid.parameters).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
    expect(d.paths['/api/records/donation/{id}/transitions/cancel']).toBeDefined();
    for (const action of ['sendReminder', 'payNow', 'printReceipt']) {
      expect(d.paths[`/api/records/donation/{id}/actions/${action}`]!.post!.operationId).toBe(`donation_action_${action}`);
    }
    expect(Object.keys(d.paths).filter((p) => p.includes('/actions/'))).toHaveLength(3);
    expect(Object.keys(d.paths).filter((p) => p.includes('/transitions/'))).toHaveLength(2);
  });

  it("shows only what the caller may read and do, from the organisation's own configuration", async () => {
    const ctx = w.as(w.ngoA);
    await w.platform.definitions.saveDraft(ctx, 'recordType', {
      key: 'volunteer',
      label: 'Volunteer',
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
    });
    await w.platform.definitions.publish(ctx, 'recordType', 'volunteer');

    const mine = await doc(dev(w.ngoA));
    expect(mine.components.schemas.volunteer!.required).toEqual(['name']);
    expect(mine.paths['/api/records/volunteer']).toBeDefined();
    const theirs = await doc(dev(w.ngoB));
    expect(theirs.components.schemas.volunteer).toBeUndefined();
    expect(theirs.info.title).toBe('Bodhi Society API');

    const { token } = await newKey('Read only docs', 'viewer');
    const viewer = await doc(key(token));
    expect(viewer.components.schemas.volunteer).toBeUndefined();
    expect(Object.keys(viewer.paths['/api/records/donation']!)).toEqual(['get']);
    expect(Object.keys(viewer.paths['/api/records/donation/{id}']!)).toEqual(['parameters', 'get']);
    expect(Object.keys(viewer.paths).some((p) => p.includes('/transitions/') || p.includes('/actions/'))).toBe(false);
    expect(viewer.components.schemas.donor).toBeDefined();

    expect((await app.inject({ method: 'GET', url: '/api/openapi.json' })).statusCode).toBe(403);
  });
});
