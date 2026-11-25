import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../src/application/migration/migration-service.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { createWorld, type TestWorld } from './helpers.js';

/** While a run is in progress the profile shows the counts so far and the latest failed rows; afterwards it does not list failures. */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;
const TYPE = 'liveCase';

const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(migrator), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  await w.platform.definitions.saveDraft(w.as(w.ngoA), 'recordType', {
    key: TYPE,
    label: 'Live case',
    titleField: 'name',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
  } as never);
  await w.platform.definitions.publish(w.as(w.ngoA), 'recordType', TYPE);
  const permissions = ['data:migrate', `record:${TYPE}:*`];
  const [u] = await w.platform.db.asSystem((tx) => tx.query<{ id: string }>(`insert into app_user (email, display_name) values ('migration-live@example.org', 'migration-live') returning id`));
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, 'held-migration-live', 'held-migration-live', $2::text[])`, [w.ngoA, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, 'held-migration-live')`, [w.ngoA, u!.id]);
  });
  migrator = { id: u!.id, roles: [], permissions };
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('a running migration', () => {
  it('shows the counts so far and the latest failed rows, newest first', async () => {
    // 250 rows, one batch is 100: rows 3 and 40 fail (no name), so a run stopped after one batch has two failures to show.
    const rows = ['Id,Name', ...Array.from({ length: 250 }, (_, i) => `L-${i + 1},${i === 2 || i === 39 ? '' : `Person ${i + 1}`}`)].join('\r\n');
    const created = await ok(await call('POST', '/api/migrations', { name: 'Live view' }), 201);
    const added = await app.inject({ method: 'POST', url: `/api/migrations/${created.id}/sources`, headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': 'live.csv' }, payload: Buffer.from(rows) });
    const source = (await ok(added, 201)).sources[0]!;
    await ok(await call('PUT', `/api/migrations/${created.id}/sources/${source.id}/mapping`, { targets: [{ key: 'c', type: TYPE, oldId: 'Id', fields: { name: 'Name' }, refs: {} }] }));
    await ok(await call('POST', `/api/migrations/${created.id}/check`), 202);
    await w.platform.jobs.runOnce();
    await ok(await call('POST', `/api/migrations/${created.id}/run`), 202);

    const started = await ok(await call('GET', `/api/migrations/${created.id}`));
    expect(started.status).toBe('running');
    expect(started.recentFailures).toEqual([]);

    // A budget of one millisecond stops the job after its first batch.
    await w.platform.jobs.runOnce({ timeBudgetMs: 1 });
    const midway = await ok(await call('GET', `/api/migrations/${created.id}`));
    expect(midway.status).toBe('running');
    expect(midway.sources[0]!.counts).toMatchObject({ created: 98, failed: 2 });
    expect(midway.recentFailures.map((f) => f.fileName)).toEqual(['live.csv', 'live.csv']);
    expect(midway.recentFailures.map((f) => f.message)).toEqual(['Name is required', 'Name is required']);

    await w.platform.jobs.runOnce({ timeBudgetMs: 280_000 });
    const done = await ok(await call('GET', `/api/migrations/${created.id}`));
    expect(done.status).toBe('done');
    expect(done.recentFailures).toEqual([]);
    expect(done.sources[0]!.counts).toEqual({ created: 248, updated: 0, failed: 2 });
  });
});
