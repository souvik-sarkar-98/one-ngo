import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../src/application/migration/migration-service.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { createWorld, type TestWorld } from './helpers.js';

/** Several files for one record type: a later file that maps only some fields updates the records an earlier file made. */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;

const TYPE = 'mergeDonor';
const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const call = (actor: Actor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(actor), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const recordOf = async (oldId: string) => {
  const rows = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`select r.id from migration_key k join record r on r.id = k.record_id where k.tenant_id = $1 and k.type_key = $2 and k.old_id = $3`, [w.ngoA, TYPE, oldId]),
  );
  if (!rows[0]) return null;
  return (await w.platform.records.query(w.as(w.ngoA), TYPE, { limit: 200 })).items.find((r) => r.id === rows[0]!.id) ?? null;
};

const CSV = (header: string[], rows: string[][]) => [header, ...rows].map((r) => r.join(',')).join('\r\n');
const IDENTITY = { targets: [{ key: 'd', type: TYPE, oldId: 'Id', fields: { name: 'Name', email: 'Email' }, refs: {} }] };
const AMOUNT = { targets: [{ key: 'd', type: TYPE, oldId: 'Id', fields: { amount: 'Amount' }, refs: {} }] };

interface Upload {
  name: string;
  csv: string;
  mapping: unknown;
}
/** One profile with the files, in order, each mapped; checked and (unless `run` is false) run. */
async function load(files: Upload[], options: { run?: boolean } = {}): Promise<{ id: string; check: ProfileView; done: ProfileView }> {
  const created = await ok(await call(migrator, 'POST', '/api/migrations', { name: `Records ${files[0]!.name}` }), 201);
  for (const f of files) {
    const added = await app.inject({
      method: 'POST',
      url: `/api/migrations/${created.id}/sources`,
      headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': f.name },
      payload: Buffer.from(f.csv),
    });
    const source = (await ok(added, 201)).sources.find((s) => s.fileName === f.name)!;
    await ok(await call(migrator, 'PUT', `/api/migrations/${created.id}/sources/${source.id}/mapping`, f.mapping));
  }
  await ok(await call(migrator, 'POST', `/api/migrations/${created.id}/check`), 202);
  await w.platform.jobs.runOnce();
  const check = await ok(await call(migrator, 'GET', `/api/migrations/${created.id}`));
  if (options.run === false) return { id: created.id, check, done: check };
  await ok(await call(migrator, 'POST', `/api/migrations/${created.id}/run`), 202);
  await w.platform.jobs.runOnce({ timeBudgetMs: 280_000 });
  return { id: created.id, check, done: await ok(await call(migrator, 'GET', `/api/migrations/${created.id}`)) };
}

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  await publish('recordType', {
    key: TYPE,
    label: 'Merge donor',
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ],
  });
  const permissions = ['data:migrate', `record:${TYPE}:*`];
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ('records-merge@example.org', 'records-merge') returning id`),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, 'held-records-merge', 'held-records-merge', $2::text[])`, [w.ngoA, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, 'held-records-merge')`, [w.ngoA, u!.id]);
  });
  migrator = { id: u!.id, roles: [], permissions };
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('record files that add to the same records', () => {
  it('updates the fields a later file maps on records an earlier file made, and keeps the rest', async () => {
    const identity = CSV(['Id', 'Name', 'Email'], [
      ['R-1', 'Asha Rao', 'asha.rao@example.org'],
      ['R-2', 'Ravi Kumar', 'ravi.kumar@example.org'],
    ]);
    const amounts = CSV(['Id', 'Amount'], [
      ['R-1', '500'],
      ['R-2', '1200'],
    ]);
    const l = await load([
      { name: 'identity.csv', csv: identity, mapping: IDENTITY },
      { name: 'amounts.csv', csv: amounts, mapping: AMOUNT },
    ]);
    expect(l.check.check).toMatchObject({ invalid: 0, problems: [] });
    expect(l.done.status).toBe('done');
    expect(l.done.sources.find((s) => s.fileName === 'amounts.csv')!.counts).toEqual({ created: 0, updated: 2, failed: 0 });
    expect(await recordOf('R-1')).toMatchObject({ data: { name: 'Asha Rao', email: 'asha.rao@example.org', amount: 500 } });
    expect(await recordOf('R-2')).toMatchObject({ data: { name: 'Ravi Kumar', amount: 1200 } });
  });

  it('refuses a new row that its file leaves without the required name, with the field message', async () => {
    const amounts = CSV(['Id', 'Amount'], [['R-9', '75']]);
    const l = await load([{ name: 'orphan-amount.csv', csv: amounts, mapping: AMOUNT }], { run: false });
    expect(l.check.check).toMatchObject({ invalid: 1, ready: 0 });
    expect(l.check.check!.problems[0]).toMatchObject({ row: 2, field: 'name' });
    expect(l.check.check!.problems[0]!.message).toContain('Name');
    expect(await recordOf('R-9')).toBeNull();
  });
});
