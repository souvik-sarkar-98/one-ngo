import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../src/application/migration/migration-service.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { createWorld, type TestWorld } from './helpers.js';

/** Several people files for one set of people: a later file that gives only roles adds them to people an earlier file added. */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;

const PERMISSIONS = ['data:migrate', 'data:migrate:people', 'members:manage', 'people:read'];

async function member(name: string, permissions: string[]): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name}@example.org`, name]),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, $2, $2, $3::text[])`, [w.ngoA, `held-${name}`, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [w.ngoA, u!.id, `held-${name}`]);
  });
  return { id: u!.id, roles: [], permissions };
}
const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const call = (actor: Actor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(actor), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const q = <T extends object>(sql: string, args: unknown[] = []) => w.platform.db.asSystem((tx) => tx.query<T>(sql, args));
const rolesOf = async (email: string) =>
  (await q<{ role_key: string }>(`select ra.role_key from role_assignment ra join app_user u on u.id = ra.user_id where ra.tenant_id = $1 and lower(u.email) = $2 order by 1`, [w.ngoA, email])).map((r) => r.role_key);
const nameOf = async (email: string) =>
  (await q<{ display_name: string }>(`select m.display_name from tenant_member m join app_user u on u.id = m.user_id where m.tenant_id = $1 and lower(u.email) = $2`, [w.ngoA, email]))[0]?.display_name;

const CSV = (rows: string[][]) => ['Id,Email,Name,Roles', ...rows.map((r) => r.join(','))].join('\r\n');
/** Roles-only rows keep the email and name columns in the file, empty. */
const ROLES_MAP = { kind: 'people', people: { oldId: 'Id', email: 'Email', name: 'Name', roles: { column: 'Roles', separator: ';', map: { Volunteer: 'volunteer', Guest: null } } } };
const PLAIN_MAP = { kind: 'people', people: { oldId: 'Id', email: 'Email', name: 'Name', roles: { column: 'Roles', separator: ';', map: { Volunteer: 'volunteer' } } } };

interface Upload {
  name: string;
  csv: string;
  mapping: unknown;
}
/** One profile with the files, in order, each mapped; checked and (unless `run` is false) run. */
async function load(files: Upload[], options: { run?: boolean } = {}): Promise<{ id: string; check: ProfileView; done: ProfileView }> {
  const created = await ok(await call(migrator, 'POST', '/api/migrations', { name: `Merge ${files[0]!.name}` }), 201);
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
  migrator = await member('merge-migrator', PERMISSIONS);
  await q(`insert into role (tenant_id, key, label, permissions, require_two_step) values ($1, 'volunteer', 'volunteer', array['people:read'], false)`, [w.ngoA]);
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('people files that add to the same people', () => {
  it('adds the roles of a later file that has only roles to people an earlier file added, and keeps their name and email', async () => {
    const people = CSV([
      ['P-1', 'merge.one@example.org', 'Merge One', ''],
      ['P-2', 'merge.two@example.org', 'Merge Two', ''],
    ]);
    const roles = CSV([
      ['P-1', '', '', 'Volunteer'],
      ['P-2', '', '', 'Volunteer;Guest'],
    ]);
    const l = await load([
      { name: 'identity.csv', csv: people, mapping: PLAIN_MAP },
      { name: 'roles.csv', csv: roles, mapping: ROLES_MAP },
    ]);
    expect(l.check.check).toMatchObject({ invalid: 0, problems: [] });
    expect(l.done.status).toBe('done');
    expect(l.done.sources.find((s) => s.fileName === 'roles.csv')!.counts).toEqual({ created: 0, updated: 2, failed: 0 });
    expect(await rolesOf('merge.one@example.org')).toEqual(['volunteer']);
    expect(await rolesOf('merge.two@example.org')).toEqual(['volunteer']);
    expect(await nameOf('merge.one@example.org')).toBe('Merge One');
  });

  it('lets a roles-only row follow the row that adds its person in the same file', async () => {
    const csv = CSV([
      ['S-1', 'same.file@example.org', 'Same File', ''],
      ['S-1', '', '', 'Volunteer'],
    ]);
    const l = await load([{ name: 'same.csv', csv, mapping: PLAIN_MAP }]);
    expect(l.check.check).toMatchObject({ ready: 2, invalid: 0 });
    expect(l.done.sources[0]!.counts).toEqual({ created: 1, updated: 1, failed: 0 });
    expect(await rolesOf('same.file@example.org')).toEqual(['volunteer']);
  });

  it('refuses a roles-only row whose legacy id no file has added', async () => {
    const l = await load([{ name: 'orphan.csv', csv: CSV([['X-404', '', '', 'Volunteer']]), mapping: ROLES_MAP }], { run: false });
    expect(l.check.check).toMatchObject({ invalid: 1, ready: 0 });
    expect(l.check.check!.problems[0]).toMatchObject({ row: 2, column: 'Email', severity: 'error' });
  });

  it('refuses a row that gives an email but no name, even when its legacy id is already here', async () => {
    const identity = CSV([['P-9', 'half.row@example.org', 'Half Row', '']]);
    const half = CSV([['P-9', 'half.row@example.org', '', 'Volunteer']]);
    const l = await load(
      [
        { name: 'half-identity.csv', csv: identity, mapping: PLAIN_MAP },
        { name: 'half.csv', csv: half, mapping: ROLES_MAP },
      ],
      { run: false },
    );
    expect(l.check.check!.problems.find((p) => p.message === 'Name is required')).toBeTruthy();
    expect(l.check.check!.invalid).toBe(1);
  });
});
