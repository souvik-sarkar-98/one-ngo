import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../src/application/migration/migration-service.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { postgresMemberStore } from '../src/infrastructure/postgres/stores/member-store.js';
import { createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;
let migratorB: Actor;

const PERMISSIONS = ['data:migrate', 'data:migrate:people', 'members:manage', 'people:read', 'record:supporter:read'];

async function member(tenant: string, name: string, permissions: string[]): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) => tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name}@example.org`, name]));
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [tenant, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, $2, $2, $3::text[])`, [tenant, `held-${name}`, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [tenant, u!.id, `held-${name}`]);
  });
  return { id: u!.id, roles: [], permissions };
}
const headers = (actor: Actor, tenant = w.ngoA) => ({ 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) });
const call = (actor: Actor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, tenant = w.ngoA) =>
  app.inject({ method, url, headers: headers(actor, tenant), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const q = <T extends object>(sql: string, args: unknown[] = []) => w.platform.db.asSystem((tx) => tx.query<T>(sql, args));
const count = async (sql: string, args: unknown[] = []) => Number((await q<{ n: number }>(sql, args))[0]!.n);
const userOf = async (email: string) => (await q<{ id: string; display_name: string; password_hash: string | null }>(`select id, display_name, password_hash from app_user where lower(email) = $1`, [email]))[0];
const memberOf = async (tenant: string, email: string) =>
  (await q<{ user_id: string; display_name: string | null; status: string; locale: string | null; last_signed_in_at: Date | null }>(
    `select m.user_id, m.display_name, m.status, m.locale, m.last_signed_in_at from tenant_member m join app_user u on u.id = m.user_id where m.tenant_id = $1 and lower(u.email) = $2`,
    [tenant, email],
  ))[0];
const rolesOf = async (tenant: string, email: string) =>
  (await q<{ role_key: string }>(`select ra.role_key from role_assignment ra join app_user u on u.id = ra.user_id where ra.tenant_id = $1 and lower(u.email) = $2 order by 1`, [tenant, email])).map((r) => r.role_key);
const keysOf = async (tenant: string) => Object.fromEntries((await q<{ old_id: string; email: string }>(`select k.old_id, lower(u.email) as email from migration_person_key k join app_user u on u.id = k.user_id where k.tenant_id = $1`, [tenant])).map((r) => [r.old_id, r.email]));

const CSV = (rows: string[][], header = ['Id', 'Email', 'Name', 'Roles', 'Active', 'Lang']) =>
  [header, ...rows].map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');
const MAPPING = {
  kind: 'people',
  people: {
    oldId: 'Id',
    email: 'Email',
    name: 'Name',
    roles: { column: 'Roles', separator: ';', map: { Volunteer: 'volunteer', Helper: 'helper', Guest: null } },
    status: { column: 'Active', active: ['1', 'yes'], suspended: ['0', 'no'] },
    locale: 'Lang',
  },
};
const PLAIN = { kind: 'people', people: { oldId: 'Id', email: 'Email', name: 'Name' } };

interface Loaded {
  id: string;
  check: ProfileView;
  done: ProfileView;
}
let sequence = 0;
/** Uploads, maps, checks and (unless `run` is false) runs one people file as a new profile. */
async function load(csv: string, mapping: unknown = MAPPING, options: { actor?: Actor; tenant?: string; run?: boolean } = {}): Promise<Loaded> {
  const actor = options.actor ?? migrator;
  const tenant = options.tenant ?? w.ngoA;
  const created = await ok(await call(actor, 'POST', '/api/migrations', { name: `People ${++sequence}` }, tenant), 201);
  const added = await app.inject({
    method: 'POST',
    url: `/api/migrations/${created.id}/sources`,
    headers: { ...headers(actor, tenant), 'content-type': 'text/csv', 'x-file-name': 'people.csv' },
    payload: Buffer.from(csv),
  });
  const file = (await ok(added, 201)).sources[0]!;
  const mapped = await ok(await call(actor, 'PUT', `/api/migrations/${created.id}/sources/${file.id}/mapping`, mapping, tenant));
  expect(mapped.sources[0]).toMatchObject({ kind: 'people', mapping });
  await ok(await call(actor, 'POST', `/api/migrations/${created.id}/check`, undefined, tenant), 202);
  await w.platform.jobs.runOnce();
  const check = await ok(await call(actor, 'GET', `/api/migrations/${created.id}`, undefined, tenant));
  if (options.run === false) return { id: created.id, check, done: check };
  await ok(await call(actor, 'POST', `/api/migrations/${created.id}/run`, undefined, tenant), 202);
  await w.platform.jobs.runOnce({ timeBudgetMs: 280_000 });
  return { id: created.id, check, done: await ok(await call(actor, 'GET', `/api/migrations/${created.id}`, undefined, tenant)) };
}
const countsOf = (v: ProfileView) => v.sources[0]!.counts;
const failedCsv = async (l: Loaded, actor = migrator) => (await call(actor, 'GET', `/api/migrations/${l.id}/sources/${l.done.sources[0]!.id}/failed.csv`)).body;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  migrator = await member(w.ngoA, 'people-migrator', PERMISSIONS);
  migratorB = await member(w.ngoB, 'people-migrator-b', PERMISSIONS);
  const roles: [string, string[], boolean][] = [
    ['volunteer', ['people:read'], false],
    ['helper', ['record:supporter:read'], false],
    ['secure', ['people:read'], true],
    ['powerful', ['admin:settings'], false],
  ];
  for (const tenant of [w.ngoA, w.ngoB]) {
    for (const [key, permissions, twoStep] of roles) {
      await q(`insert into role (tenant_id, key, label, permissions, require_two_step) values ($1, $2, $2, $3::text[], $4)`, [tenant, key, permissions, twoStep]);
    }
  }
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});
afterEach(() => vi.restoreAllMocks());

describe('people files: mapping access', () => {
  it('needs data:migrate:people and members:manage to map, check or run one', async () => {
    const noPeople = await member(w.ngoA, 'no-people-perm', ['data:migrate', 'members:manage']);
    const noManage = await member(w.ngoA, 'no-manage-perm', ['data:migrate', 'data:migrate:people']);
    for (const actor of [noPeople, noManage]) {
      const created = await ok(await call(actor, 'POST', '/api/migrations', { name: 'Denied' }), 201);
      const added = await app.inject({
        method: 'POST',
        url: `/api/migrations/${created.id}/sources`,
        headers: { ...headers(actor), 'content-type': 'text/csv', 'x-file-name': 'p.csv' },
        payload: Buffer.from(CSV([['1', 'x@example.org', 'X', '', '', '']])),
      });
      const file = (await ok(added, 201)).sources[0]!;
      expect((await call(actor, 'PUT', `/api/migrations/${created.id}/sources/${file.id}/mapping`, PLAIN)).statusCode).toBe(403);
    }
    // A file mapped by someone who held both is refused at check and run once one is lost.
    const l = await load(CSV([['1', 'gone-1@example.org', 'Gone', '', '', '']]), PLAIN, { run: false });
    await q(`update role set permissions = array['data:migrate', 'data:migrate:people'] where tenant_id = $1 and key = 'held-people-migrator'`, [w.ngoA]);
    const lost: Actor = { ...migrator, permissions: ['data:migrate', 'data:migrate:people'] };
    expect((await call(lost, 'POST', `/api/migrations/${l.id}/check`)).statusCode).toBe(403);
    expect((await call(lost, 'POST', `/api/migrations/${l.id}/run`)).statusCode).toBe(403);
    await q(`update role set permissions = $2::text[] where tenant_id = $1 and key = 'held-people-migrator'`, [w.ngoA, PERMISSIONS]);
  });

  it('reports the issue paths of a bad people mapping as a 422', async () => {
    const created = await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Paths' }), 201);
    const added = await app.inject({
      method: 'POST',
      url: `/api/migrations/${created.id}/sources`,
      headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': 'p.csv' },
      payload: Buffer.from(CSV([['1', 'x@example.org', 'X', 'Admin', '', '']])),
    });
    const file = (await ok(added, 201)).sources[0]!;
    const bad = await call(migrator, 'PUT', `/api/migrations/${created.id}/sources/${file.id}/mapping`, {
      kind: 'people',
      people: { ...PLAIN.people, roles: { column: 'Roles', map: { Admin: 'owner' } } },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().issues).toEqual([{ path: '/people/roles/map/Admin', message: "'owner' is not a role" }]);
    // The coarse contract refuses a body with other top-level keys that is not a mapping at all.
    expect((await call(migrator, 'PUT', `/api/migrations/${created.id}/sources/${file.id}/mapping`, { people: 'x' })).statusCode).toBe(400);
  });

  it('keeps the old records mapping working next to people files, with a kind on every source', async () => {
    const created = await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Kinds' }), 201);
    const added = await app.inject({
      method: 'POST',
      url: `/api/migrations/${created.id}/sources`,
      headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': 'raw.csv' },
      payload: Buffer.from('A,B\r\n1,2'),
    });
    expect((await ok(added, 201)).sources[0]).toMatchObject({ kind: 'records', mapping: null });
  });
});

describe('people files: check', () => {
  it('reports every problem and warning of plan 3.6 from this organisation alone', async () => {
    await q(`insert into app_user (email, display_name) values ('already-member@example.org', 'Already') on conflict do nothing`);
    await q(`insert into tenant_member (tenant_id, user_id, display_name) select $1, id, 'Already' from app_user where email = 'already-member@example.org'`, [w.ngoA]);
    const rows = [
      ['c1', 'ok-1@example.org', 'Fine One', 'Volunteer', '1', 'en'],
      ['c2', 'not-an-email', 'Bad Email', '', '1', ''],
      ['c3', 'ok-3@example.org', '', '', '1', ''],
      ['c4', 'ok-4@example.org', 'Unknown Role', 'Mystery', '1', ''],
      ['c5', 'ok-5@example.org', 'Secure Role', 'secure', '1', ''],
      ['c6', 'ok-6@example.org', 'Too Much', 'powerful', '1', ''],
      ['c7', 'ok-7@example.org', 'Odd Status', '', 'maybe', ''],
      ['c8', 'ok-8@example.org', 'Odd Language', '', '1', 'xx'],
      ['c9', 'ok-9@example.org', 'Two Emails', '', '1', ''],
      ['c9', 'other-9@example.org', 'Two Emails', '', '1', ''],
      ['d1', 'shared@example.org', 'Shared One', '', '1', ''],
      ['d2', 'SHARED@example.org', 'Shared Two', '', '1', ''],
      ['s1', 'ok-s1@example.org', 'Suspended Roles', 'Volunteer;Guest', 'no', ''],
      ['m1', 'already-member@example.org', 'Already', '', '1', ''],
    ];
    const { check, id } = await load(CSV(rows), MAPPING, { run: false });
    expect(check.check).toMatchObject({ rows: 14, ready: 6, invalid: 8, creates: 4, updates: 2 });
    const problems = check.check!.problems.map((p) => [p.row, p.column, p.message]);
    expect(problems).toEqual([
      [3, 'Email', 'Email is not a valid address'],
      [4, 'Name', 'Name is required'],
      [5, 'Roles', "Role 'Mystery' does not exist"],
      [6, 'Roles', "Role 'secure' requires two-step sign-in, so it cannot be given here. Give it after the person has signed in and set up two-step"],
      [7, 'Roles', "You cannot give the role 'powerful'"],
      [8, 'Active', "Status 'maybe' is in neither the active nor the suspended list"],
      [9, 'Lang', "Language 'xx' is not offered by this organisation"],
      [11, 'Email', "Legacy id 'c9' appears with two different emails in this file"],
    ]);
    expect(check.check!.problems.every((p) => p.severity === 'error')).toBe(true);
    const warnings = Object.fromEntries(check.check!.warnings.map((x) => [x.kind, x]));
    expect(Object.keys(warnings).sort()).toEqual(['already-members', 'duplicate-email', 'roles-skipped-suspended']);
    expect(warnings['already-members']).toMatchObject({ count: 1, fileName: 'people.csv' });
    expect(warnings['duplicate-email']).toMatchObject({ count: 1, samples: ['Legacy ids d1, d2 share one email; they will be one person'] });
    expect(warnings['roles-skipped-suspended']).toMatchObject({ count: 1, samples: ['Legacy id s1 is suspended, so its roles are skipped'] });
    // A check saves nothing.
    expect(await keysOf(w.ngoA)).toEqual({});
    expect(await userOf('ok-1@example.org')).toBeUndefined();
    expect(id).toBeTruthy();
  });

  it('flags a legacy id already linked to another email, from this organisation own mapping', async () => {
    await load(CSV([['lk-1', 'linked-1@example.org', 'Linked One', '', '1', '']]));
    const { check } = await load(CSV([['lk-1', 'linked-other@example.org', 'Linked One', '', '1', '']]), MAPPING, { run: false });
    expect(check.check!.problems.map((p) => p.message)).toEqual(['This legacy user id is already linked to someone else here.']);
    expect(await userOf('linked-other@example.org')).toBeUndefined();
  });

  it('hides personal samples of a people file but keeps the role column visible for the role map', async () => {
    const l = await load(CSV([['h-1', 'hide-1@example.org', 'Hidden Name', 'Volunteer', '1', 'en']]), MAPPING, { run: false });
    const columns = Object.fromEntries(l.check.sources[0] ? (await ok(await call(migrator, 'GET', `/api/migrations/${l.id}`))).sources[0]!.columns.map((c) => [c.name, c.samples]) : []);
    expect(columns).toMatchObject({ Id: [], Email: [], Name: [], Roles: ['Volunteer'] });
  });
});

describe('people files: run', () => {
  it('adds Invited members with no password, token or mail, for UUID, integer and text ids', async () => {
    const uuid = randomUUID();
    const emails = ['ru-1@example.org', 'ru-2@example.org', 'ru-3@example.org', 'ru-4@example.org'];
    const before = { mail: w.mail.sent.length, tokens: await count(`select count(*)::int as n from password_token`), notices: await count(`select count(*)::int as n from notification where to_address = any($1::text[])`, [emails]) };
    const l = await load(
      CSV([
        [uuid, ' Ru-1@Example.org ', ' Uma  Rao ', 'Volunteer;Guest', '1', 'hi'],
        ['42', emails[1]!, 'Kiran Das', 'Helper', 'yes', 'en'],
        ['EMP-007', emails[2]!, 'Meena Iyer', '', '', ''],
        ['mixed/ö 9', emails[3]!, 'Zoya Khan', 'Janitor', '0', ''],
      ]),
      { ...MAPPING, people: (({ status: _status, ...rest }) => rest)(MAPPING.people) },
    );
    // Without a status column everyone is active, whatever the file's Active column says.
    expect(l.check.check).toMatchObject({ ready: 3, invalid: 1 });
    expect(l.check.check!.problems.map((p) => p.message)).toEqual(["Role 'Janitor' does not exist"]);
    expect(countsOf(l.done)).toEqual({ created: 3, updated: 0, failed: 1 });
    expect(l.done.status).toBe('done');
    expect(await failedCsv(l)).toContain("Role 'Janitor' does not exist");

    expect(await keysOf(w.ngoA)).toMatchObject({ [uuid]: 'ru-1@example.org', '42': emails[1], 'EMP-007': emails[2] });
    const one = (await memberOf(w.ngoA, 'ru-1@example.org'))!;
    expect(one).toMatchObject({ display_name: 'Uma  Rao', status: 'active', locale: 'hi', last_signed_in_at: null });
    expect(await rolesOf(w.ngoA, 'ru-1@example.org')).toEqual(['volunteer']);
    expect(await rolesOf(w.ngoA, emails[1]!)).toEqual(['helper']);
    expect((await memberOf(w.ngoA, emails[3]!))).toBeUndefined();

    for (const email of emails.slice(0, 3)) expect((await userOf(email))!.password_hash).toBeNull();
    expect(await count(`select count(*)::int as n from password_token`)).toBe(before.tokens);
    expect(await count(`select count(*)::int as n from notification where to_address = any($1::text[])`, [emails])).toBe(before.notices);
    expect(w.mail.sent.filter((m) => emails.some((e) => JSON.stringify(m).toLowerCase().includes(e)))).toEqual([]);
    expect(w.mail.sent.length).toBe(before.mail);

    const listed = await w.platform.people.list(w.as(w.ngoA), { limit: 200 });
    expect(listed.items.filter((p) => emails.includes(p.email)).map((p) => p.status)).toEqual(['invited', 'invited', 'invited']);
    expect(await count(`select count(*)::int as n from audit_event where tenant_id = $1 and action = 'member.imported'`, [w.ngoA])).toBeGreaterThanOrEqual(3);
  });

  it('gives roles by column with a role map, a fixed list, and another separator', async () => {
    await load(CSV([['fx-1', 'fx-1@example.org', 'Fixed One', '', '1', '']]), { kind: 'people', people: { ...PLAIN.people, roles: { fixed: ['volunteer', 'helper'] } } });
    expect(await rolesOf(w.ngoA, 'fx-1@example.org')).toEqual(['helper', 'volunteer']);
    await load(CSV([['fx-2', 'fx-2@example.org', 'Comma Two', 'Volunteer, Helper', '', '']], ['Id', 'Email', 'Name', 'Roles', 'Active', 'Lang']), {
      kind: 'people',
      people: { ...PLAIN.people, roles: { column: 'Roles', separator: ',', map: { volunteer: 'volunteer', helper: 'helper' } } },
    });
    expect(await rolesOf(w.ngoA, 'fx-2@example.org')).toEqual(['helper', 'volunteer']);
  });

  it('refuses a role the migrator may not give and a role needing two-step at check and at run time', async () => {
    const l = await load(CSV([['rf-1', 'rf-1@example.org', 'Refused', 'powerful', '', '']]), { kind: 'people', people: { ...PLAIN.people, roles: { column: 'Roles' } } }, { run: false });
    expect(l.check.check!.problems.map((p) => p.message)).toEqual(["You cannot give the role 'powerful'"]);
    // The check is what stops it; a run refuses the same rows.
    await ok(await call(migrator, 'POST', `/api/migrations/${l.id}/run`), 202);
    await w.platform.jobs.runOnce();
    const done = await ok(await call(migrator, 'GET', `/api/migrations/${l.id}`));
    expect(countsOf(done)).toEqual({ created: 0, updated: 0, failed: 1 });
    expect(await userOf('rf-1@example.org')).toBeUndefined();

    const two = await load(CSV([['rf-2', 'rf-2@example.org', 'Two Step', 'secure', '', '']]), { kind: 'people', people: { ...PLAIN.people, roles: { column: 'Roles' } } }, { run: false });
    expect(two.check.check!.problems[0]!.message).toMatch(/requires two-step sign-in/);
    await ok(await call(migrator, 'POST', `/api/migrations/${two.id}/run`), 202);
    await w.platform.jobs.runOnce();
    expect(countsOf(await ok(await call(migrator, 'GET', `/api/migrations/${two.id}`)))).toEqual({ created: 0, updated: 0, failed: 1 });
    expect(await rolesOf(w.ngoA, 'rf-2@example.org')).toEqual([]);
    // Run-time refusal even when the role became two-step after the check.
    await q(`update role set require_two_step = true where tenant_id = $1 and key = 'helper'`, [w.ngoA]);
    const late = await load(CSV([['rf-3', 'rf-3@example.org', 'Late', 'Helper', '1', '']]), MAPPING, { run: false });
    await q(`update role set require_two_step = false where tenant_id = $1 and key = 'helper'`, [w.ngoA]);
    const ready = await load(CSV([['rf-3', 'rf-3@example.org', 'Late', 'Helper', '1', '']]), MAPPING, { run: false });
    await q(`update role set require_two_step = true where tenant_id = $1 and key = 'helper'`, [w.ngoA]);
    await ok(await call(migrator, 'POST', `/api/migrations/${ready.id}/run`), 202);
    await w.platform.jobs.runOnce();
    expect(countsOf(await ok(await call(migrator, 'GET', `/api/migrations/${ready.id}`)))).toEqual({ created: 0, updated: 0, failed: 1 });
    await q(`update role set require_two_step = false where tenant_id = $1 and key = 'helper'`, [w.ngoA]);
    expect(late.check.check!.problems).toHaveLength(1);
    expect(await userOf('rf-3@example.org')).toBeUndefined();
  });

  it('creates suspended members when the file says so, without roles, and counts the skipped roles as a warning', async () => {
    const l = await load(CSV([['sp-1', 'sp-1@example.org', 'Gone Away', 'Volunteer', 'no', '']]));
    expect(countsOf(l.done)).toEqual({ created: 1, updated: 0, failed: 0, warned: 1 });
    expect(await memberOf(w.ngoA, 'sp-1@example.org')).toMatchObject({ status: 'suspended' });
    expect(await rolesOf(w.ngoA, 'sp-1@example.org')).toEqual([]);
  });

  it('normalises emails and maps two legacy ids with one email to one person, uniting their roles', async () => {
    const l = await load(
      CSV([
        ['tw-1', ' Twin@Example.ORG ', 'Twin', 'Volunteer', '1', ''],
        ['tw-2', 'twin@example.org', 'Twin Again', 'Helper', '1', ''],
      ]),
    );
    expect(l.check.check!.warnings.map((x) => x.kind)).toEqual(['duplicate-email']);
    expect(countsOf(l.done)).toEqual({ created: 1, updated: 1, failed: 0 });
    const keys = await keysOf(w.ngoA);
    expect(keys['tw-1']).toBe('twin@example.org');
    expect(keys['tw-2']).toBe('twin@example.org');
    expect(await count(`select count(*)::int as n from app_user where lower(email) = 'twin@example.org'`)).toBe(1);
    expect(await rolesOf(w.ngoA, 'twin@example.org')).toEqual(['helper', 'volunteer']);
    // The second row only linked the person: the name given by the first stays.
    expect((await memberOf(w.ngoA, 'twin@example.org'))!.display_name).toBe('Twin');
  });

  it('stops at the next batch with a clear message when the creator loses access', async () => {
    const lonely = await member(w.ngoA, 'loses-access', PERMISSIONS);
    const l = await load(CSV([['la-1', 'la-1@example.org', 'Lost Access', '', '', '']]), PLAIN, { actor: lonely, run: false });
    await ok(await call(lonely, 'POST', `/api/migrations/${l.id}/run`), 202);
    await q(`update role set permissions = array['data:migrate', 'data:migrate:people'] where tenant_id = $1 and key = 'held-loses-access'`, [w.ngoA]);
    await w.platform.jobs.runOnce();
    const view = await ok(await call(lonely, 'GET', `/api/migrations/${l.id}`));
    expect(view.status).toBe('failed');
    const [job] = await q<{ status: string; error: string }>(`select status, error from job where id = $1`, [view.jobId]);
    expect(job).toMatchObject({ status: 'failed' });
    expect(job!.error).toMatch(/no longer have permission to add people/);
    expect(await userOf('la-1@example.org')).toBeUndefined();
  });
});

describe('people files: the conflict table', () => {
  const first = CSV([
    ['ct-1', 'ct-1@example.org', 'Cora One', 'Volunteer', '1', 'en'],
    ['ct-2', 'ct-2@example.org', 'Cyrus Two', '', '1', ''],
    ['ct-3', 'ct-3@example.org', 'Cleo Three', 'Helper', '1', ''],
  ]);

  it('changes nothing on a second run, then follows edited names and languages and adds roles only', async () => {
    const one = await load(first);
    expect(countsOf(one.done)).toEqual({ created: 3, updated: 0, failed: 0 });
    const state = async () => ({
      members: await count(`select count(*)::int as n from tenant_member where tenant_id = $1`, [w.ngoA]),
      roles: await count(`select count(*)::int as n from role_assignment where tenant_id = $1`, [w.ngoA]),
      keys: await count(`select count(*)::int as n from migration_person_key where tenant_id = $1`, [w.ngoA]),
      users: await count(`select count(*)::int as n from app_user`),
      audit: await count(`select count(*)::int as n from audit_event where tenant_id = $1 and action = 'member.imported'`, [w.ngoA]),
    });
    const before = await state();
    const again = await load(first);
    expect(countsOf(again.done)).toEqual({ created: 0, updated: 3, failed: 0 });
    expect(again.check.check).toMatchObject({ creates: 0, updates: 3 });
    expect(await state()).toEqual(before);

    // An edited name and language update, a new role is added, a role missing from the file is not removed.
    await q(`insert into role_assignment (tenant_id, user_id, role_key) select $1, user_id, 'helper' from tenant_member m join app_user u on u.id = m.user_id where m.tenant_id = $1 and u.email = 'ct-2@example.org'`, [w.ngoA]);
    const edited = await load(
      CSV([
        ['ct-1', 'ct-1@example.org', 'Cora Renamed', 'Helper', '1', 'ta'],
        ['ct-2', 'ct-2@example.org', 'Cyrus Two', '', '1', ''],
        ['ct-3', 'ct-3@example.org', 'Cleo Three', '', '1', ''],
      ]),
    );
    expect(countsOf(edited.done)).toEqual({ created: 0, updated: 3, failed: 0 });
    expect(await memberOf(w.ngoA, 'ct-1@example.org')).toMatchObject({ display_name: 'Cora Renamed', locale: 'ta' });
    expect(await rolesOf(w.ngoA, 'ct-1@example.org')).toEqual(['helper', 'volunteer']);
    expect(await rolesOf(w.ngoA, 'ct-2@example.org')).toEqual(['helper']);
    expect(await rolesOf(w.ngoA, 'ct-3@example.org')).toEqual(['helper']);
  });

  it('never changes a status: a suspended member stays suspended and gets no role, an active one stays active', async () => {
    const userId = (await memberOf(w.ngoA, 'ct-2@example.org'))!.user_id;
    await q(`update tenant_member set status = 'suspended' where tenant_id = $1 and user_id = $2`, [w.ngoA, userId]);
    const l = await load(CSV([['ct-2', 'ct-2@example.org', 'Cyrus Two', 'Volunteer', '1', ''], ['ct-3', 'ct-3@example.org', 'Cleo Three', '', '0', '']]));
    expect(countsOf(l.done)).toEqual({ created: 0, updated: 2, failed: 0, warned: 1 });
    expect((await memberOf(w.ngoA, 'ct-2@example.org'))!.status).toBe('suspended');
    expect(await rolesOf(w.ngoA, 'ct-2@example.org')).toEqual(['helper']);
    expect((await memberOf(w.ngoA, 'ct-3@example.org'))!.status).toBe('active');
  });

  it('fails a row whose legacy id is linked to another email, before creating any account', async () => {
    const accounts = await count(`select count(*)::int as n from app_user`);
    const l = await load(CSV([['ct-1', 'ct-1-new@example.org', 'Cora Elsewhere', '', '1', ''], ['ct-9', 'ct-9@example.org', 'Cora Nine', '', '1', '']]));
    expect(countsOf(l.done)).toEqual({ created: 1, updated: 0, failed: 1 });
    expect(await failedCsv(l)).toContain('This legacy user id is already linked to someone else here.');
    expect(await userOf('ct-1-new@example.org')).toBeUndefined();
    expect(await count(`select count(*)::int as n from app_user`)).toBe(accounts + 1);
    expect((await keysOf(w.ngoA))['ct-1']).toBe('ct-1@example.org');
  });

  it('links an active member who was not migrated and leaves their name and language alone', async () => {
    const admin = await memberOf(w.ngoA, 'people-migrator@example.org');
    const l = await load(CSV([['adm-1', 'people-migrator@example.org', 'Someone Else Entirely', 'Volunteer', '1', 'ta']]));
    expect(countsOf(l.done)).toEqual({ created: 0, updated: 1, failed: 0 });
    const after = (await memberOf(w.ngoA, 'people-migrator@example.org'))!;
    expect(after.display_name).toBe(admin!.display_name);
    expect(after.locale).toBe(admin!.locale);
    expect(after.status).toBe('active');
    expect((await keysOf(w.ngoA))['adm-1']).toBe('people-migrator@example.org');
    expect(await rolesOf(w.ngoA, 'people-migrator@example.org')).toContain('volunteer');
  });

  it('refuses a globally disabled account that is not a member with the generic wording only', async () => {
    await q(`insert into app_user (email, display_name, status) values ('disabled-1@example.org', 'Secret Disabled', 'disabled')`);
    const l = await load(CSV([['dis-1', 'disabled-1@example.org', 'Dee Able', '', '1', '']]));
    expect(countsOf(l.done)).toEqual({ created: 0, updated: 0, failed: 1 });
    const failed = await failedCsv(l);
    expect(failed).toContain('This email cannot be added. Ask the person to contact support.');
    expect(failed).not.toMatch(/Secret Disabled|disabled'?\s*(account|everywhere)/i);
    expect(await memberOf(w.ngoA, 'disabled-1@example.org')).toBeUndefined();
    expect((await keysOf(w.ngoA))['dis-1']).toBeUndefined();
    // The check cannot predict it, so it does not mention it either.
    expect(JSON.stringify(l.check.check)).not.toMatch(/disabled|support/i);
  });
});

describe('people files: other organisations stay invisible', () => {
  it('reuses an existing account silently: same id, password, name, and nothing in the check, errors or counts', async () => {
    await q(`insert into app_user (email, display_name, password_hash, totp_enabled) values ('shared-person@example.org', 'Name Held Elsewhere', 'scrypt$secret-hash', false)`);
    const original = (await userOf('shared-person@example.org'))!;
    await q(`insert into tenant_member (tenant_id, user_id, display_name, last_signed_in_at) values ($1, $2, 'Name Held Elsewhere', now())`, [w.ngoB, original.id]);
    await q(`insert into role (tenant_id, key, label, permissions) values ($1, 'secret-b-role', 'Secret B Role', array['admin:settings'])`, [w.ngoB]);
    await q(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, 'secret-b-role')`, [w.ngoB, original.id]);

    const withShared = await load(CSV([['sh-1', 'Shared-Person@Example.org', 'Local Name', 'Volunteer', '1', 'en'], ['sh-2', 'sh-fresh@example.org', 'Fresh Person', 'Volunteer', '1', 'en']]));
    const after = (await userOf('shared-person@example.org'))!;
    expect(after).toEqual(original);
    expect((await memberOf(w.ngoA, 'shared-person@example.org'))).toMatchObject({ display_name: 'Local Name', status: 'active', last_signed_in_at: null });
    expect(await rolesOf(w.ngoA, 'shared-person@example.org')).toEqual(['volunteer']);
    expect(await rolesOf(w.ngoB, 'shared-person@example.org')).toEqual(['secret-b-role']);

    // A reused account looks exactly like a new one: same counts, no extra field anywhere.
    expect(countsOf(withShared.done)).toEqual({ created: 2, updated: 0, failed: 0 });
    expect(withShared.check.check).toMatchObject({ ready: 2, invalid: 0, creates: 2, updates: 0, warnings: [], problems: [] });
    const everything = JSON.stringify([withShared.check, withShared.done]);
    expect(everything).not.toMatch(/Name Held Elsewhere|Secret B Role|secret-b-role|bodhi|Bodhi|scrypt|already/i);
  });

  it('keeps two organisations with the same legacy ids and emails apart', async () => {
    const csv = CSV([['same-1', 'dual-1@example.org', 'Dual One', 'Volunteer', '1', ''], ['same-2', 'dual-2@example.org', 'Dual Two', 'Helper', '1', '']]);
    const a = await load(csv);
    const b = await load(csv, MAPPING, { actor: migratorB, tenant: w.ngoB });
    expect(countsOf(a.done)).toEqual({ created: 2, updated: 0, failed: 0 });
    expect(countsOf(b.done)).toEqual({ created: 2, updated: 0, failed: 0 });
    expect(await count(`select count(*)::int as n from app_user where email like 'dual-%'`)).toBe(2);
    expect(await count(`select count(*)::int as n from migration_person_key where old_id like 'same-%'`)).toBe(4);
    for (const tenant of [w.ngoA, w.ngoB]) {
      const own = await w.platform.db.withTenant(tenant, (tx) => tx.query<{ tenant_id: string; old_id: string }>(`select tenant_id, old_id from migration_person_key`));
      expect(own.every((r) => r.tenant_id === tenant)).toBe(true);
      expect(own.filter((r) => r.old_id.startsWith('same-'))).toHaveLength(2);
    }
    // Organisation B's profile reads nothing of A's mappings, so the same ids are new there.
    expect(await keysOf(w.ngoB)).toMatchObject({ 'same-1': 'dual-1@example.org', 'same-2': 'dual-2@example.org' });
  });

  it('refuses a cross-tenant insert on migration_person_key with a row-level security error', async () => {
    const user = (await userOf('dual-1@example.org'))!;
    await expect(
      w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`insert into migration_person_key (tenant_id, old_id, user_id) values ($1, 'smuggled', $2)`, [w.ngoB, user.id])),
    ).rejects.toThrow(/row-level security/);
    await expect(w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`delete from migration_person_key`))).rejects.toThrow(/permission denied/);
  });
});

describe('people files: recovery and erasure', () => {
  it('converges after a crash between the account and the membership', async () => {
    const email = 'crash-1@example.org';
    const spy = vi.spyOn(postgresMemberStore, 'importJoin').mockRejectedValueOnce(new Error('boom between account and membership'));
    const l = await load(CSV([['cr-1', email, 'Crash One', 'Volunteer', '1', ''], ['cr-2', 'crash-2@example.org', 'Crash Two', '', '1', '']]));
    expect(spy).toHaveBeenCalled();
    expect(l.done.status).toBe('failed');
    // Only a global account with no membership remains; nothing in any organisation shows it.
    expect(await count(`select count(*)::int as n from app_user where lower(email) = $1`, [email])).toBe(1);
    expect(await memberOf(w.ngoA, email)).toBeUndefined();
    expect((await keysOf(w.ngoA))['cr-1']).toBeUndefined();

    spy.mockRestore();
    const again = await load(CSV([['cr-1', email, 'Crash One', 'Volunteer', '1', ''], ['cr-2', 'crash-2@example.org', 'Crash Two', '', '1', '']]));
    expect(countsOf(again.done)).toEqual({ created: 2, updated: 0, failed: 0 });
    expect(await count(`select count(*)::int as n from app_user where lower(email) = $1`, [email])).toBe(1);
    expect(await memberOf(w.ngoA, email)).toMatchObject({ status: 'active' });
    expect(await rolesOf(w.ngoA, email)).toEqual(['volunteer']);
    expect((await keysOf(w.ngoA))['cr-1']).toBe(email);
  });

  it('deletes the legacy ids of a person when a privacy erasure of that member runs', async () => {
    await load(CSV([['er-1', 'erase-me@example.org', 'Erin Erase', '', '0', ''], ['er-2', 'keep-me@example.org', 'Keep Kim', '', '0', '']]));
    const gone = (await userOf('erase-me@example.org'))!;
    expect((await keysOf(w.ngoA))['er-1']).toBe('erase-me@example.org');
    const result = await w.platform.privacy.erase(w.as(w.ngoA), { subjectKind: 'member', subjectId: gone.id, reason: 'subject_request' } as never);
    expect(result).toBeTruthy();
    const keys = await keysOf(w.ngoA);
    expect(Object.values(keys)).not.toContain('erase-me@example.org');
    expect(await count(`select count(*)::int as n from migration_person_key where tenant_id = $1 and user_id = $2`, [w.ngoA, gone.id])).toBe(0);
    expect(keys['er-2']).toBe('keep-me@example.org');
  });
});

describe('people files: load', () => {
  it('runs a 2,000-row people file in reasonable time', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => [String(100000 + i), `load-${i}@example.org`, `Load Person ${i}`, i % 3 === 0 ? 'Volunteer' : '', '1', 'en']);
    const upload = process.hrtime.bigint();
    const l = await load(CSV(rows), MAPPING, { run: false });
    expect(l.check.check).toMatchObject({ rows: 2000, ready: 2000, invalid: 0, creates: 2000 });
    const checkedMs = Number(process.hrtime.bigint() - upload) / 1e6;
    const started = process.hrtime.bigint();
    await ok(await call(migrator, 'POST', `/api/migrations/${l.id}/run`), 202);
    await w.platform.jobs.runOnce({ timeBudgetMs: 280_000 });
    const runMs = Number(process.hrtime.bigint() - started) / 1e6;
    const done = await ok(await call(migrator, 'GET', `/api/migrations/${l.id}`));
    expect(countsOf(done)).toEqual({ created: 2000, updated: 0, failed: 0 });
    const rerun = await load(CSV(rows), MAPPING, { run: false });
    const second = process.hrtime.bigint();
    await ok(await call(migrator, 'POST', `/api/migrations/${rerun.id}/run`), 202);
    await w.platform.jobs.runOnce({ timeBudgetMs: 280_000 });
    const rerunMs = Number(process.hrtime.bigint() - second) / 1e6;
    expect(countsOf(await ok(await call(migrator, 'GET', `/api/migrations/${rerun.id}`)))).toEqual({ created: 0, updated: 2000, failed: 0 });
    // R10: report the measured time; 20,000 rows are ten times this when it scales linearly.
    console.log(`people load: upload+map+check 2,000 rows ${checkedMs.toFixed(0)} ms; run ${runMs.toFixed(0)} ms (${(runMs / 2000).toFixed(1)} ms/row, 20,000 rows ~ ${((runMs * 10) / 1000).toFixed(0)} s); re-run ${rerunMs.toFixed(0)} ms`);
    expect(runMs).toBeLessThan(120_000);
  }, 400_000);
});
