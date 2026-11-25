import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../src/application/migration/migration-service.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;
let migratorB: Actor;

const PERMISSIONS = ['data:migrate', 'data:migrate:people', 'members:manage', 'people:read', 'record:giftrecord:*'];

async function member(tenant: string, name: string, permissions: string[]): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) => tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name}@example.org`, name]));
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [tenant, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, $2, $2, $3::text[])`, [tenant, `held-${name}`, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [tenant, u!.id, `held-${name}`]);
  });
  return { id: u!.id, roles: [], permissions };
}
const headers = (actor: Actor, tenant: string) => ({ 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) });
const call = (actor: Actor, tenant: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(actor, tenant), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const q = <T extends object>(sql: string, args: unknown[] = []) => w.platform.db.asSystem((tx) => tx.query<T>(sql, args));
const userId = async (tenant: string, email: string) =>
  (await q<{ user_id: string }>(`select m.user_id from tenant_member m join app_user u on u.id = m.user_id where m.tenant_id = $1 and lower(u.email) = $2`, [tenant, email]))[0]?.user_id;
const donations = async (tenant: string) => (await w.platform.records.query(w.as(tenant), 'giftrecord', { limit: 500, sort: { field: 'createdAt', dir: 'asc' } })).items;
const ownerOf = async (tenant: string, name: string) => (await donations(tenant)).find((d) => d.data.name === name)?.data.owner;

const CSV = (header: string[], rows: string[][]) => [header, ...rows].map((r) => r.join(',')).join('\r\n');
const PEOPLE_HEADER = ['Id', 'Email', 'Name', 'Active'];
const PEOPLE_MAP = { kind: 'people', people: { oldId: 'Id', email: 'Email', name: 'Name', status: { column: 'Active', active: ['1'], suspended: ['0'] } } };
const GIFT_HEADER = ['Gift', 'Title', 'OwnerId'];
const giftMap = (persons: Record<string, unknown> = { owner: { column: 'OwnerId' } }, fields: Record<string, string> = { name: 'Title' }) => ({
  targets: [{ key: 'd', type: 'giftrecord', oldId: 'Gift', fields, persons }],
});

interface Loaded {
  id: string;
  check: ProfileView;
  done: ProfileView;
}
let sequence = 0;
/** One profile with an optional people file then a donations file; checks it and (unless `run` is false) runs it. */
async function load(
  gifts: { csv: string; mapping?: unknown } ,
  people?: string,
  options: { actor?: Actor; tenant?: string; run?: boolean } = {},
): Promise<Loaded> {
  const actor = options.actor ?? migrator;
  const tenant = options.tenant ?? w.ngoA;
  const created = await ok(await call(actor, tenant, 'POST', '/api/migrations', { name: `Persons ${++sequence}` }), 201);
  const add = async (name: string, csv: string, mapping: unknown) => {
    const added = await app.inject({
      method: 'POST',
      url: `/api/migrations/${created.id}/sources`,
      headers: { ...headers(actor, tenant), 'content-type': 'text/csv', 'x-file-name': name },
      payload: Buffer.from(csv),
    });
    const file = (await ok(added, 201)).sources.find((s) => s.fileName === name)!;
    await ok(await call(actor, tenant, 'PUT', `/api/migrations/${created.id}/sources/${file.id}/mapping`, mapping));
  };
  // The donations file is added first, so mapping it must be reordered after the people file once that is mapped.
  await add('donations.csv', gifts.csv, gifts.mapping ?? giftMap());
  if (people !== undefined) await add('people.csv', people, PEOPLE_MAP);
  await ok(await call(actor, tenant, 'POST', `/api/migrations/${created.id}/check`), 202);
  await w.platform.jobs.runOnce();
  const check = await ok(await call(actor, tenant, 'GET', `/api/migrations/${created.id}`));
  if (options.run === false) return { id: created.id, check, done: check };
  await ok(await call(actor, tenant, 'POST', `/api/migrations/${created.id}/run`), 202);
  await w.platform.jobs.runOnce({ timeBudgetMs: 280_000 });
  return { id: created.id, check, done: await ok(await call(actor, tenant, 'GET', `/api/migrations/${created.id}`)) };
}
const counts = (v: ProfileView, file: string) => v.sources.find((s) => s.fileName === file)!.counts;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  migrator = await member(w.ngoA, 'persons-migrator', PERMISSIONS);
  migratorB = await member(w.ngoB, 'persons-migrator-b', PERMISSIONS);
  for (const tenant of [w.ngoA, w.ngoB]) {
    const body = {
      key: 'giftrecord',
      label: 'Gift record',
      titleField: 'name',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'owner', label: 'Owner', type: 'person' },
        { key: 'ownerText', label: 'Owner text', type: 'text' },
      ],
    };
    await w.platform.definitions.saveDraft(w.as(tenant), 'recordType' as DefinitionKind, body as never);
    await w.platform.definitions.publish(w.as(tenant), 'recordType' as DefinitionKind, 'giftrecord');
  }
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('person fields by legacy user id', () => {
  it('fills the field from UUID, integer and text legacy ids, and leaves a blank cell blank', async () => {
    const uuid = randomUUID();
    const l = await load(
      {
        csv: CSV(GIFT_HEADER, [
          ['g1', 'Gift UUID', uuid],
          ['g2', 'Gift integer', '42'],
          ['g3', 'Gift text', 'EMP-007'],
          ['g4', 'Gift blank', ''],
        ]),
      },
      CSV(PEOPLE_HEADER, [
        [uuid, 'pf-uuid@example.org', 'Uma Rao', '1'],
        ['42', 'pf-int@example.org', 'Kiran Das', '1'],
        ['EMP-007', 'pf-text@example.org', 'Meena Iyer', '1'],
      ]),
    );
    // Saving the donations mapping first and the people file after reorders the people file before it.
    expect(l.done.sources.map((s) => s.fileName)).toEqual(['people.csv', 'donations.csv']);
    // Ids planned by the people file in the same profile count as found: no warning, no problem.
    expect(l.check.check).toMatchObject({ invalid: 0, problems: [], warnings: [] });
    expect(counts(l.done, 'donations.csv')).toEqual({ created: 4, updated: 0, failed: 0 });
    expect(await ownerOf(w.ngoA, 'Gift UUID')).toBe(await userId(w.ngoA, 'pf-uuid@example.org'));
    expect(await ownerOf(w.ngoA, 'Gift integer')).toBe(await userId(w.ngoA, 'pf-int@example.org'));
    expect(await ownerOf(w.ngoA, 'Gift text')).toBe(await userId(w.ngoA, 'pf-text@example.org'));
    expect(await ownerOf(w.ngoA, 'Gift blank')).toBeUndefined();
  });

  it('leaves an unresolved id blank, saves the row, counts it as warned and warns once per distinct id', async () => {
    const l = await load({
      csv: CSV(GIFT_HEADER, [
        ['w1', 'Warn one', 'ghost-1'],
        ['w2', 'Warn two', 'ghost-2'],
        ['w3', 'Warn three', 'ghost-1'],
        ['w4', 'Warn four', 'ghost-3'],
        ['w5', 'Warn five', 'ghost-4'],
        ['w6', 'Warn six', 'ghost-5'],
        ['w7', 'Warn seven', 'ghost-6'],
      ]),
    });
    expect(l.check.check!.problems).toEqual([]);
    expect(l.check.check!.warnings).toEqual([
      { kind: 'unresolved-legacy-users', sourceId: l.check.sources[0]!.id, fileName: 'donations.csv', column: 'OwnerId', count: 6, samples: ['ghost-1', 'ghost-2', 'ghost-3', 'ghost-4', 'ghost-5'] },
    ]);
    expect(counts(l.done, 'donations.csv')).toEqual({ created: 7, updated: 0, failed: 0, warned: 7 });
    expect(await ownerOf(w.ngoA, 'Warn one')).toBeUndefined();
    expect((await donations(w.ngoA)).filter((d) => String(d.data.name).startsWith('Warn ')).length).toBe(7);
  });

  it("with onMissing 'fail' an unresolved id is a blocking problem and fails the row at run time", async () => {
    const l = await load({
      csv: CSV(GIFT_HEADER, [
        ['f1', 'Fail missing', 'nobody-9'],
        ['f2', 'Fail fine', ''],
      ]),
      mapping: giftMap({ owner: { column: 'OwnerId', onMissing: 'fail' } }),
    });
    expect(l.check.check).toMatchObject({ ready: 1, invalid: 1, warnings: [] });
    expect(l.check.check!.problems[0]).toMatchObject({ row: 2, column: 'OwnerId', message: "Owner: no person was loaded with legacy user id 'nobody-9'" });
    expect(counts(l.done, 'donations.csv')).toEqual({ created: 1, updated: 0, failed: 1 });
    expect(await ownerOf(w.ngoA, 'Fail missing')).toBeUndefined();
    expect((await donations(w.ngoA)).some((d) => d.data.name === 'Fail missing')).toBe(false);
  });

  it('links a suspended member during the run only; a normal save still refuses one, and a non-member is refused even then', async () => {
    const l = await load(
      { csv: CSV(GIFT_HEADER, [['s1', 'Suspended owner', 'sus-1']]) },
      CSV(PEOPLE_HEADER, [['sus-1', 'pf-suspended@example.org', 'Sam Suspended', '0']]),
    );
    expect(l.check.check).toMatchObject({ problems: [], warnings: [] });
    expect(counts(l.done, 'donations.csv')).toEqual({ created: 1, updated: 0, failed: 0 });
    const suspended = (await userId(w.ngoA, 'pf-suspended@example.org'))!;
    expect((await q<{ status: string }>(`select status from tenant_member where tenant_id = $1 and user_id = $2`, [w.ngoA, suspended]))[0]!.status).toBe('suspended');
    expect(await ownerOf(w.ngoA, 'Suspended owner')).toBe(suspended);

    // A normal save refuses a suspended member.
    await expect(w.platform.records.create(w.as(w.ngoA), 'giftrecord', { name: 'Normal save', owner: suspended })).rejects.toMatchObject({
      issues: [{ path: '/owner', message: 'must be an active member of the organisation' }],
    });
    // The relaxation is explicit and narrow: a suspended member passes with the flag, a member of another organisation never does.
    await expect(w.platform.records.create({ ...w.as(w.ngoA), migrating: true }, 'giftrecord', { name: 'Flagged save', owner: suspended })).resolves.toBeTruthy();
    const outsider = (await userId(w.ngoB, 'persons-migrator-b@example.org'))!;
    await expect(w.platform.records.create({ ...w.as(w.ngoA), migrating: true }, 'giftrecord', { name: 'Outsider save', owner: outsider })).rejects.toMatchObject({
      issues: [{ path: '/owner', message: 'must be an active member of the organisation' }],
    });
  });

  it('lets one column fill a person field and a text field', async () => {
    const l = await load(
      { csv: CSV(GIFT_HEADER, [['b1', 'Both fields', 'both-1']]), mapping: giftMap({ owner: { column: 'OwnerId' } }, { name: 'Title', ownerText: 'OwnerId' }) },
      CSV(PEOPLE_HEADER, [['both-1', 'pf-both@example.org', 'Bo Th', '1']]),
    );
    expect(counts(l.done, 'donations.csv')).toEqual({ created: 1, updated: 0, failed: 0 });
    const d = (await donations(w.ngoA)).find((x) => x.data.name === 'Both fields')!;
    expect(d.data).toMatchObject({ owner: await userId(w.ngoA, 'pf-both@example.org'), ownerText: 'both-1' });
  });

  it('keeps two organisations with the same legacy ids apart', async () => {
    const people = (email: string) => CSV(PEOPLE_HEADER, [['dup-1', email, 'Dup Person', '1']]);
    const gifts = { csv: CSV(GIFT_HEADER, [['x1', 'Dup gift', 'dup-1']]) };
    await load(gifts, people('pf-dup-a@example.org'));
    await load(gifts, people('pf-dup-b@example.org'), { actor: migratorB, tenant: w.ngoB });
    expect(await ownerOf(w.ngoA, 'Dup gift')).toBe(await userId(w.ngoA, 'pf-dup-a@example.org'));
    expect(await ownerOf(w.ngoB, 'Dup gift')).toBe(await userId(w.ngoB, 'pf-dup-b@example.org'));
    expect(await userId(w.ngoA, 'pf-dup-b@example.org')).toBeUndefined();
    // Organisation B alone does not know A's legacy ids: they warn there.
    const alone = await load({ csv: CSV(GIFT_HEADER, [['x2', 'Dup alone', 'sus-1']]) }, undefined, { actor: migratorB, tenant: w.ngoB, run: false });
    expect(alone.check.check!.warnings).toMatchObject([{ kind: 'unresolved-legacy-users', count: 1, samples: ['sus-1'] }]);
  });

  it('is a no-op the second time', async () => {
    const csv = CSV(GIFT_HEADER, [['r1', 'Rerun gift', 'rr-1'], ['r2', 'Rerun ghost', 'rr-ghost']]);
    const people = CSV(PEOPLE_HEADER, [['rr-1', 'pf-rerun@example.org', 'Re Run', '1']]);
    const first = await load({ csv }, people);
    expect(counts(first.done, 'donations.csv')).toEqual({ created: 2, updated: 0, failed: 0, warned: 1 });
    const before = (await donations(w.ngoA)).filter((d) => String(d.data.name).startsWith('Rerun ')).map((d) => [d.id, d.data.owner]);
    const second = await load({ csv }, people);
    expect(counts(second.done, 'donations.csv')).toEqual({ created: 0, updated: 2, failed: 0, warned: 1 });
    const after = (await donations(w.ngoA)).filter((d) => String(d.data.name).startsWith('Rerun ')).map((d) => [d.id, d.data.owner]);
    expect(after).toEqual(before);
  });
});
