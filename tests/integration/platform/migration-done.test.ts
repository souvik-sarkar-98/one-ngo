import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../../../packages/platform/src/application/migration/migration-service.js';
import type { Actor } from '../../../packages/platform/src/infrastructure/postgres/db.js';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';

/** A done migration is read-only: its files, mappings, order, books and check cannot change; it can still be read and purged. */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;
const TYPE = 'doneCase';
const MAPPING = { targets: [{ key: 'c', type: TYPE, oldId: 'Id', fields: { name: 'Name' }, refs: {} }] };
const CSV = 'Id,Name\r\nD-1,Asha Rao\r\nD-2,Ravi Kumar';

const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(migrator), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}

/** A profile with one file, checked and run to done. */
async function done(): Promise<ProfileView> {
  const created = await ok(await call('POST', '/api/migrations', { name: 'Done migration' }), 201);
  const added = await app.inject({
    method: 'POST',
    url: `/api/migrations/${created.id}/sources`,
    headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': 'cases.csv' },
    payload: Buffer.from(CSV),
  });
  const source = (await ok(added, 201)).sources[0]!;
  await ok(await call('PUT', `/api/migrations/${created.id}/sources/${source.id}/mapping`, MAPPING));
  await ok(await call('POST', `/api/migrations/${created.id}/check`), 202);
  await w.platform.jobs.runOnce();
  await ok(await call('POST', `/api/migrations/${created.id}/run`), 202);
  await w.platform.jobs.runOnce({ timeBudgetMs: 280_000 });
  return ok(await call('GET', `/api/migrations/${created.id}`));
}

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  await w.platform.definitions.saveDraft(w.as(w.ngoA), 'recordType', {
    key: TYPE,
    label: 'Done case',
    titleField: 'name',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
  } as never);
  await w.platform.definitions.publish(w.as(w.ngoA), 'recordType', TYPE);
  const permissions = ['data:migrate', 'data:migrate:books', `record:${TYPE}:*`];
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ('migration-done@example.org', 'migration-done') returning id`),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, 'held-migration-done', 'held-migration-done', $2::text[])`, [w.ngoA, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, 'held-migration-done')`, [w.ngoA, u!.id]);
  });
  migrator = { id: u!.id, roles: [], permissions };
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('a done migration is read-only', () => {
  it('refuses every change to its files, mappings, order, check and books, and keeps it readable', async () => {
    const view = await done();
    expect(view.status).toBe('done');
    const id = view.id;
    const source = view.sources[0]!;
    const refused = async (res: Promise<Awaited<ReturnType<typeof call>>>) => {
      const r = await res;
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ message: expect.stringContaining('read-only') });
    };

    await refused(app.inject({ method: 'POST', url: `/api/migrations/${id}/sources`, headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': 'late.csv' }, payload: Buffer.from(CSV) }));
    await refused(call('DELETE', `/api/migrations/${id}/sources/${source.id}`));
    await refused(call('PUT', `/api/migrations/${id}/sources/${source.id}/mapping`, MAPPING));
    await refused(call('PUT', `/api/migrations/${id}/order`, { sourceIds: [source.id] }));
    await refused(app.inject({ method: 'POST', url: `/api/migrations/${id}/attachments`, headers: { ...headers(migrator), 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('late.pdf') }, payload: Buffer.from('%PDF-1.4') }));
    await refused(call('DELETE', `/api/migrations/${id}/attachments`));
    await refused(call('POST', `/api/migrations/${id}/check`));
    await refused(call('PUT', `/api/migrations/${id}/books`, { lines: [] }));

    const after = await ok(await call('GET', `/api/migrations/${id}`));
    expect(after.status).toBe('done');
    expect(after.sources.map((s) => s.fileName)).toEqual(['cases.csv']);
  });

  it('still lets a done migration be purged', async () => {
    const view = await done();
    await ok(await call('POST', `/api/migrations/${view.id}/purge`), 200);
  });
});
