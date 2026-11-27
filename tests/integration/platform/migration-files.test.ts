import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { readMapping, type TypesByKey } from '../../../packages/platform/src/application/migration/mapping.js';
import type { ProfileView } from '../../../packages/platform/src/application/migration/migration-service.js';
import type { Actor } from '../../../packages/platform/src/infrastructure/postgres/db.js';
import { TENANT_TABLES } from '../../../packages/platform/src/infrastructure/postgres/tenant-export.js';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';

/** Files and attachments of a data migration: upload, mapping, check, run, clean-up, purge. */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;
let colleague: Actor;
let tenantB: Actor;
const MB = 1024 * 1024;

function png(padding = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4), Buffer.alloc(padding, 7)]);
}
const pdf = () => Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');

async function member(name: string, permissions: string[], tenant = w.ngoA): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name}@example.org`, name]),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [tenant, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, $2, $2, $3::text[])`, [tenant, `held-${name}`, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [tenant, u!.id, `held-${name}`]);
  });
  return { id: u!.id, roles: [], permissions };
}
const headers = (actor: Actor, tenant = w.ngoA) => ({ 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) });
const call = (actor: Actor, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, tenant = w.ngoA) =>
  app.inject({ method, url, headers: headers(actor, tenant), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const addCsv = (actor: Actor, id: string, name: string, text: string) =>
  app.inject({ method: 'POST', url: `/api/migrations/${id}/sources`, headers: { ...headers(actor), 'content-type': 'text/csv', 'x-file-name': encodeURIComponent(name) }, payload: Buffer.from(text) });
const attach = (actor: Actor, id: string, path: string, body: Buffer, tenant = w.ngoA) =>
  app.inject({ method: 'POST', url: `/api/migrations/${id}/attachments`, headers: { ...headers(actor, tenant), 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(path) }, payload: body });
const sql = async <T extends object>(text: string, args: unknown[] = []) => w.platform.db.asSystem((tx) => tx.query<T>(text, args));
const count = async (text: string, args: unknown[] = []) => Number((await sql<{ n: number }>(text, args))[0]!.n);

const csv = (...rows: string[]) => ['Id,Name,Photo,Papers,Scan', ...rows].join('\r\n');
const mapping = (files: Record<string, unknown>) => ({ targets: [{ key: 'c', type: 'case', oldId: 'Id', fields: { name: 'Name' }, files }] });
const PHOTO = { photo: { column: 'Photo' } };

/** A profile with the uploads, one CSV and its mapping; not yet checked. */
async function setup(name: string, text: string, files: Record<string, unknown>, uploads: [string, Buffer][] = [], actor = migrator): Promise<ProfileView> {
  const id = (await ok(await call(actor, 'POST', '/api/migrations', { name }), 201)).id;
  for (const [path, body] of uploads) expect((await attach(actor, id, path, body)).statusCode, path).toBe(201);
  const view = await ok(await addCsv(actor, id, `${name}.csv`, text), 201);
  return ok(await call(actor, 'PUT', `/api/migrations/${id}/sources/${view.sources[0]!.id}/mapping`, mapping(files)));
}
/** Starts the check (a background job, answered 202), runs that job, and returns the checked profile. */
async function check(id: string, actor = migrator): Promise<ProfileView> {
  await ok(await call(actor, 'POST', `/api/migrations/${id}/check`), 202);
  await w.platform.jobs.runOnce();
  return ok(await call(actor, 'GET', `/api/migrations/${id}`));
}
async function run(id: string, actor = migrator): Promise<ProfileView> {
  await ok(await call(actor, 'POST', `/api/migrations/${id}/run`), 202);
  await w.platform.jobs.runOnce();
  return ok(await call(actor, 'GET', `/api/migrations/${id}`));
}
const failures = async (view: ProfileView) => (await sql<{ message: string }>(`select message from job_item where job_id = $1 and status = 'failed' order by seq`, [view.jobId])).map((r) => r.message);
const record = async (oldId: string) =>
  (await sql<{ id: string; data: Record<string, unknown> }>(`select r.id, r.data from migration_key k join record r on r.id = k.record_id where k.tenant_id = $1 and k.type_key = 'case' and k.old_id = $2`, [w.ngoA, oldId]))[0];
const fileOf = async (profileId: string, path: string) =>
  (await sql<{ id: string; record_id: string | null; field_key: string | null; deleted_at: Date | null; storage_key: string }>(
    `select f.id, f.record_id, f.field_key, f.deleted_at, f.storage_key from migration_attachment a join file_object f on f.id = a.file_id where a.profile_id = $1 and lower(a.path) = lower($2)`,
    [profileId, path],
  ))[0]!;
const onDisk = (key: string) => existsSync(join(w.filesDir!, ...key.split('/')));

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, files: { maxUploadMb: 2, defaultQuotaMb: 50 } });
  app = buildServer(w.platform, { devAuth: true });
  migrator = await member('filer', ['data:migrate', 'record:case:*']);
  colleague = await member('colleague', ['data:migrate', 'record:case:*']);
  tenantB = await member('filer-b', ['data:migrate', 'record:case:*'], w.ngoB);
  for (const tenant of [w.ngoA, w.ngoB]) {
    await w.platform.definitions.saveDraft(w.as(tenant), 'recordType', {
      key: 'case',
      label: 'Case',
      titleField: 'name',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'photo', label: 'Photo', type: 'file', accept: ['image'], maxSizeMb: 1 },
        { key: 'papers', label: 'Papers', type: 'file', multiple: true, accept: ['pdf'] },
        { key: 'scan', label: 'Receipt scan', type: 'file', accept: ['pdf'] },
      ],
    } as never);
    await w.platform.definitions.publish(w.as(tenant), 'recordType', 'case');
  }
});
// Each test loads its own records: the old ids it uses ('C-1') mean nothing to the next one.
beforeEach(async () => {
  await sql(`delete from migration_key where tenant_id = $1`, [w.ngoA]);
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('mapping files', () => {
  const doc = {
    key: 'doc',
    label: 'Document',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'proof', label: 'Proof', type: 'file', required: true },
      { key: 'extra', label: 'Extras', type: 'file', multiple: true },
      { key: 'sig', label: 'Signature', type: 'signature' },
    ],
  };
  const types = new Map([['doc', doc]]) as unknown as TypesByKey;
  const columns = ['Id', 'Name', 'Proof', 'Extras', 'Other'];
  const target = (extra: Record<string, unknown>) => ({ targets: [{ key: 'd', type: 'doc', oldId: 'Id', fields: { name: 'Name' }, ...extra }] });
  const issues = (input: unknown) => {
    try {
      readMapping(input, columns, types);
    } catch (e) {
      return (e as { issues: { path: string; message: string }[] }).issues;
    }
    return [];
  };

  it('stores a files entry, and a required file field may stay unmapped (the check decides per row)', () => {
    const m = readMapping(target({ files: { proof: { column: 'Proof' }, extra: { column: 'Extras', separator: ',', onMissing: 'skip' } } }), columns, types);
    expect(m.targets[0]!.files).toEqual({ proof: { column: 'Proof' }, extra: { column: 'Extras', separator: ',', onMissing: 'skip' } });
    expect(issues(target({}))).toEqual([]);
  });

  it('accepts a target that maps only file fields (a Files CSV), and still wants at least one column', () => {
    const only = readMapping(target({ fields: {}, files: { proof: { column: 'Proof' } } }), columns, types);
    expect(only.targets[0]).toMatchObject({ oldId: 'Id', fields: {}, files: { proof: { column: 'Proof' } } });
    expect(issues(target({ fields: {} }))).toContainEqual({ path: '/targets/0/fields', message: 'match at least one column to a field' });
  });

  it('still reads an old mapping without files', () => {
    const plain = new Map([['plain', { key: 'plain', label: 'Plain', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }] }]]) as unknown as TypesByKey;
    const old = readMapping({ targets: [{ key: 'd', type: 'plain', oldId: 'Id', fields: { name: 'Name' }, refs: {} }] }, columns, plain);
    expect(old.targets[0]).toEqual({ key: 'd', type: 'plain', oldId: 'Id', fields: { name: 'Name' }, refs: {}, required: true });
  });

  it('refuses a column used elsewhere, a missing column, a separator on a single field, a signature and bad options', () => {
    expect(issues(target({ files: { proof: { column: 'Name' }, extra: { column: 'Extras' } } }))).toContainEqual({ path: '/targets/0/files/proof/column', message: "column 'Name' already fills 'name'" });
    expect(issues(target({ files: { proof: { column: 'Nope' } } }))).toContainEqual({ path: '/targets/0/files/proof/column', message: "the file has no column 'Nope'" });
    expect(issues(target({ files: { proof: { column: 'Proof', separator: ';' } } })).map((i) => i.path)).toContain('/targets/0/files/proof/separator');
    expect(issues(target({ files: { proof: { column: 'Proof' }, extra: { column: 'Extras', separator: '|' } } })).map((i) => i.path)).toContain('/targets/0/files/extra/separator');
    expect(issues(target({ files: { proof: { column: 'Proof', onMissing: 'blank' } } })).map((i) => i.path)).toContain('/targets/0/files/proof/onMissing');
    expect(issues(target({ files: { sig: { column: 'Other' }, proof: { column: 'Proof' } } })).map((i) => i.path)).toContain('/targets/0/files/sig');
    expect(issues(target({ files: { name: { column: 'Other' }, proof: { column: 'Proof' } } })).map((i) => i.path)).toContain('/targets/0/files/name');
  });

  it('counts a files column as used by another entry', () => {
    expect(issues(target({ files: { proof: { column: 'Proof' }, extra: { column: 'Proof' } } }))).toContainEqual({ path: '/targets/0/files/extra/column', message: "column 'Proof' already fills 'proof'" });
  });
});

describe('uploading attachments', () => {
  it('stores the file, keeps it for the profile and answers the totals; the profile view shows them', async () => {
    const id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Upload' }), 201)).id;
    const res = await attach(migrator, id, 'photos/Asha.png', png(10));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ count: 1, bytes: png(10).length });
    expect((await attach(migrator, id, 'docs/a.pdf', pdf())).json()).toEqual({ count: 2, bytes: png(10).length + pdf().length });
    expect((await ok(await call(migrator, 'GET', `/api/migrations/${id}`))).attachments).toEqual({ count: 2, bytes: png(10).length + pdf().length });
    const row = (await sql<{ uploaded_by: string; mime: string; size: string }>(`select a.uploaded_by, f.mime, a.size from migration_attachment a join file_object f on f.id = a.file_id where a.profile_id = $1 and a.path = 'photos/Asha.png'`, [id]))[0]!;
    expect(row).toMatchObject({ uploaded_by: migrator.id, mime: 'image/png', size: String(png(10).length) });
  });

  it('lists with a search, a page and how many records use each file', async () => {
    const id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'List' }), 201)).id;
    for (const p of ['b/two.png', 'a/ONE.png', 'a/three_%.png']) await attach(migrator, id, p, png());
    const all = (await call(migrator, 'GET', `/api/migrations/${id}/attachments`)).json();
    expect(all.total).toBe(3);
    expect(all.items.map((i: { path: string }) => i.path)).toEqual(['a/ONE.png', 'a/three_%.png', 'b/two.png']);
    expect(all.items[0]).toEqual({ id: expect.any(String), path: 'a/ONE.png', size: png().length, mime: 'image/png', usedBy: 0 });
    expect((await call(migrator, 'GET', `/api/migrations/${id}/attachments?q=ONE`)).json().items.map((i: { path: string }) => i.path)).toEqual(['a/ONE.png']);
    expect((await call(migrator, 'GET', `/api/migrations/${id}/attachments?q=a%2F`)).json().total).toBe(2);
    expect((await call(migrator, 'GET', `/api/migrations/${id}/attachments?q=_%25`)).json().items.map((i: { path: string }) => i.path)).toEqual(['a/three_%.png']);
    const page = (await call(migrator, 'GET', `/api/migrations/${id}/attachments?limit=1&offset=1`)).json();
    expect(page).toMatchObject({ total: 3, items: [{ path: 'a/three_%.png' }] });
  });

  it('refuses bad paths, a path used ignoring case, and a running profile', async () => {
    const id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Paths' }), 201)).id;
    for (const bad of ['../x.png', 'a/../b.png', '/x.png', 'C:/x.png', 'a/', '', 'a'.repeat(252) + '.png']) {
      const res = await attach(migrator, id, bad, png());
      expect(res.statusCode, bad).toBe(422);
    }
    expect((await attach(migrator, id, 'a'.repeat(251) + '.png', png())).statusCode).toBe(201); // 255 characters
    expect((await attach(migrator, id, 'dots..png', png())).statusCode).toBe(201);
    expect((await attach(migrator, id, 'photos\\Back.png', png())).statusCode).toBe(201); // stored with forward slashes
    expect((await sql<{ path: string }>(`select path from migration_attachment where profile_id = $1 and path like 'photos%'`, [id]))[0]!.path).toBe('photos/Back.png');
    const first = await attach(migrator, id, 'Photos/One.png', png());
    expect(first.statusCode).toBe(201);
    const dupe = await attach(migrator, id, 'photos/one.PNG', png());
    expect(dupe.statusCode).toBe(409);
    const before = await count(`select count(*)::int as n from file_object where tenant_id = $1 and deleted_at is null`, [w.ngoA]);
    expect((await attach(migrator, id, 'photos/one.PNG', png())).statusCode).toBe(409);
    expect(await count(`select count(*)::int as n from file_object where tenant_id = $1 and deleted_at is null`, [w.ngoA])).toBe(before);

    const view = await setup('Busy attachments', csv('C-1,Busy,a.png,,'), PHOTO, [['a.png', png()]]);
    await check(view.id);
    await ok(await call(migrator, 'POST', `/api/migrations/${view.id}/run`), 202);
    expect((await attach(migrator, view.id, 'late.png', png())).statusCode).toBe(409);
    expect((await call(migrator, 'DELETE', `/api/migrations/${view.id}/attachments`)).statusCode).toBe(409);
    await w.platform.jobs.runOnce();
  });

  it('refuses the 5,001st attachment and a file over the upload limit', async () => {
    const id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Many' }), 201)).id;
    expect((await attach(migrator, id, 'seed.png', png())).statusCode).toBe(201);
    await sql(
      `insert into migration_attachment (tenant_id, profile_id, path, file_id, size, uploaded_by)
       select $1, $2, 'bulk/' || n, a.file_id, a.size, a.uploaded_by from migration_attachment a, generate_series(1, 4999) n where a.profile_id = $2`,
      [w.ngoA, id],
    );
    expect((await ok(await call(migrator, 'GET', `/api/migrations/${id}`))).attachments.count).toBe(5000);
    const res = await attach(migrator, id, 'one-too-many.png', png());
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toMatch(/at most 5000 attachments/);
    expect((await attach(migrator, id, 'huge.png', png(3 * MB))).statusCode).toBe(422);
    // Removing one makes room again.
    const [gone] = await sql<{ id: string }>(`select id from migration_attachment where profile_id = $1 and path = 'bulk/1'`, [id]);
    expect((await call(migrator, 'DELETE', `/api/migrations/${id}/attachments/${gone!.id}`)).statusCode).toBe(204);
    expect((await attach(migrator, id, 'fits.png', png())).statusCode).toBe(201);
  }, 60_000);

  it('needs the migration permission', async () => {
    const id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Guarded' }), 201)).id;
    const nobody = await member('nobody-files', ['record:case:*']);
    expect((await attach(nobody, id, 'a.png', png())).statusCode).toBe(403);
    expect((await call(nobody, 'GET', `/api/migrations/${id}/attachments`)).statusCode).toBe(403);
  });

  it('refuses an upload past the organisation quota', async () => {
    const id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Quota' }), 201)).id;
    const used = (await sql<{ n: string }>(`select coalesce(sum(size), 0) as n from file_object where tenant_id = $1 and deleted_at is null`, [w.ngoA]))[0]!.n;
    await sql(`insert into tenant_setting (tenant_id, key, value) values ($1, 'files.quotaBytes', $2::jsonb)`, [w.ngoA, String(Number(used) + 100)]);
    try {
      const res = await attach(migrator, id, 'big.png', png(500));
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toMatch(/storage is full/);
      expect(await count(`select count(*)::int as n from migration_attachment where profile_id = $1`, [id])).toBe(0);
    } finally {
      await sql(`delete from tenant_setting where tenant_id = $1 and key = 'files.quotaBytes'`, [w.ngoA]);
    }
  });

  it('returns the profile to draft when an attachment is added or removed, and removes the stored file', async () => {
    const view = await setup('Reset', csv('C-1,Reset,a.png,,'), PHOTO, [['a.png', png()]]);
    expect((await check(view.id)).status).toBe('checked');
    expect((await attach(migrator, view.id, 'b.png', png())).statusCode).toBe(201);
    expect((await ok(await call(migrator, 'GET', `/api/migrations/${view.id}`))).status).toBe('draft');
    await check(view.id);
    const b = await fileOf(view.id, 'b.png');
    const [row] = await sql<{ id: string }>(`select id from migration_attachment where profile_id = $1 and path = 'b.png'`, [view.id]);
    expect(onDisk(b.storage_key)).toBe(true);
    expect((await call(migrator, 'DELETE', `/api/migrations/${view.id}/attachments/${row!.id}`)).statusCode).toBe(204);
    expect((await ok(await call(migrator, 'GET', `/api/migrations/${view.id}`))).status).toBe('draft');
    expect(onDisk(b.storage_key)).toBe(false);
    expect((await call(migrator, 'DELETE', `/api/migrations/${view.id}/attachments/${row!.id}`)).statusCode).toBe(404);
    await check(view.id);
    expect((await call(migrator, 'DELETE', `/api/migrations/${view.id}/attachments`)).statusCode).toBe(204);
    const cleared = await ok(await call(migrator, 'GET', `/api/migrations/${view.id}`));
    expect(cleared).toMatchObject({ status: 'draft', attachments: { count: 0, bytes: 0 } });
  });

  it('keeps the attachments of two organisations apart, even with the same paths', async () => {
    const a = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Same A' }), 201)).id;
    const b = (await ok(await call(tenantB, 'POST', '/api/migrations', { name: 'Same B' }, w.ngoB), 201)).id;
    expect((await attach(migrator, a, 'photos/same.png', png(1))).statusCode).toBe(201);
    expect((await attach(tenantB, b, 'photos/same.png', png(2), w.ngoB)).statusCode).toBe(201);
    for (const tenant of [w.ngoA, w.ngoB]) {
      const own = await w.platform.db.withTenant(tenant, (tx) => tx.query<{ tenant_id: string; path: string }>(`select tenant_id, path from migration_attachment where path = 'photos/same.png'`));
      expect(own).toEqual([{ tenant_id: tenant, path: 'photos/same.png' }]);
    }
    // Organisation B cannot see or address A's profile.
    expect((await call(tenantB, 'GET', `/api/migrations/${a}/attachments`, undefined, w.ngoB)).statusCode).toBe(404);
    const [file] = await sql<{ id: string }>(`select file_id as id from migration_attachment where profile_id = $1`, [a]);
    await expect(
      w.platform.db.withTenant(w.ngoA, (tx) =>
        tx.query(`insert into migration_attachment (tenant_id, profile_id, path, file_id, size, uploaded_by) values ($1, $2, 'smuggled.png', $3, 1, 'x')`, [w.ngoB, a, file!.id]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`update migration_attachment set path = 'x'`))).rejects.toThrow(/permission denied/);
  });

  it('is part of the organisation export and goes with its profile', async () => {
    expect(TENANT_TABLES).toContain('migration_attachment');
    const id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Cascade' }), 201)).id;
    await attach(migrator, id, 'c.png', png());
    expect(await count(`select count(*)::int as n from migration_attachment where profile_id = $1`, [id])).toBe(1);
    await sql(`delete from migration_profile where id = $1`, [id]);
    expect(await count(`select count(*)::int as n from migration_attachment where profile_id = $1`, [id])).toBe(0);
  });
});

describe('running with files', () => {
  it('links the attachment to the new record, finding it ignoring case', async () => {
    const view = await setup('Create', csv('C-1,Asha,PHOTOS/asha.PNG,,'), PHOTO, [['photos/Asha.png', png(5)]]);
    const checked = await check(view.id);
    expect(checked.check).toMatchObject({ ready: 1, invalid: 0, creates: 1, warnings: [] });
    const done = await run(view.id);
    expect(done.sources[0]!.counts).toEqual({ created: 1, updated: 0, failed: 0 });
    const file = await fileOf(view.id, 'photos/Asha.png');
    const rec = (await record('C-1'))!;
    expect(rec.data.photo).toBe(file.id);
    expect(file).toMatchObject({ record_id: rec.id, field_key: 'photo' });
    expect(done.attachments.count).toBe(1);
    expect((await call(migrator, 'GET', `/api/migrations/${view.id}/attachments`)).json().items[0].usedBy).toBe(1);
  });

  it('splits a multiple field by its separator and links every file', async () => {
    const files = { papers: { column: 'Papers', separator: ',' } };
    const view = await setup('Multiple', csv('C-1,Many,,"a.pdf, B.PDF, a.pdf",'), files, [['a.pdf', pdf()], ['b.pdf', pdf()]]);
    expect((await check(view.id)).check).toMatchObject({ ready: 1, invalid: 0 });
    await run(view.id);
    const rec = (await record('C-1'))!;
    expect(rec.data.papers).toEqual([(await fileOf(view.id, 'a.pdf')).id, (await fileOf(view.id, 'b.pdf')).id]);
    expect((await fileOf(view.id, 'b.pdf')).record_id).toBe(rec.id);
  });

  it('changes nothing when run again with the same file, and replaces it when the column names another', async () => {
    const view = await setup('Rerun', csv('C-1,Asha,a.png,,'), PHOTO, [['a.png', png(1)], ['b.png', png(2)]]);
    await check(view.id);
    await run(view.id);
    const first = (await record('C-1'))!;
    const a = await fileOf(view.id, 'a.png');
    expect(first.data.photo).toBe(a.id);

    // A done migration is read-only: it is not checked or run again, and its record keeps the file.
    expect((await call(migrator, 'POST', `/api/migrations/${view.id}/check`)).statusCode).toBe(409);
    expect((await record('C-1'))!.data.photo).toBe(a.id);
    expect(await fileOf(view.id, 'a.png')).toMatchObject({ record_id: first.id, field_key: 'photo', deleted_at: null });
    expect(await count(`select count(*)::int as n from file_object where record_id = $1`, [first.id])).toBe(1);

    // A later migration that names b.png for the same record: the old file is unlinked, the new one linked.
    const next = await setup('Rerun2', csv('C-1,Asha,b.png,,'), PHOTO, [['b.png', png(2)]]);
    await check(next.id);
    const replaced = await run(next.id);
    expect(replaced.sources[0]!.counts).toMatchObject({ created: 0, updated: 1, failed: 0 });
    const b = await fileOf(next.id, 'b.png');
    expect((await record('C-1'))!.data.photo).toBe(b.id);
    expect(b).toMatchObject({ record_id: first.id, field_key: 'photo' });
    expect((await fileOf(view.id, 'a.png')).record_id).toBeNull();
    expect(await count(`select count(*)::int as n from migration_attachment where profile_id = $1`, [next.id])).toBe(1);
  });

  it('refuses a file the field does not accept, and one over its size, with the normal save messages', async () => {
    const files = { photo: { column: 'Photo' }, scan: { column: 'Scan' } };
    const view = await setup('Refused', csv('C-1,Kind,,,a.png', 'C-2,Big,big.png,,', 'C-3,Fine,a.png,,'), files, [['a.png', png(3)], ['big.png', png(1.5 * MB)]]);
    const checked = await check(view.id);
    expect(checked.check!.problems.map((p) => [p.row, p.message])).toEqual([
      [2, 'Receipt scan accepts only pdf files'],
      [3, 'Photo accepts files of at most 1 MB'],
    ]);
    expect(checked.check).toMatchObject({ ready: 1, invalid: 2 });
    const done = await run(view.id);
    expect(done.sources[0]!.counts).toMatchObject({ created: 1, failed: 2 });
    expect((await failures(done)).sort()).toEqual(['Photo accepts files of at most 1 MB', 'Receipt scan accepts only pdf files']);
    expect(await record('C-1')).toBeUndefined();
    expect(await record('C-2')).toBeUndefined();
    // Failed rows leave their attachments unlinked.
    expect((await fileOf(view.id, 'big.png')).record_id).toBeNull();
  });

  it('refuses an attachment used by two rows, in the check and in the run', async () => {
    const view = await setup('Twice', csv('C-1,First,shared.png,,', 'C-2,Second,SHARED.png,,'), PHOTO, [['shared.png', png(4)]]);
    const checked = await check(view.id);
    expect(checked.check!.problems.map((p) => [p.row, p.message])).toEqual([[3, "File 'SHARED.png' is used by another row"]]);
    const done = await run(view.id);
    expect(done.sources[0]!.counts).toMatchObject({ created: 1, failed: 1 });
    expect(await failures(done)).toEqual(["File 'SHARED.png' is used by another row"]);
    const rec = (await record('C-1'))!;
    expect((await fileOf(view.id, 'shared.png')).record_id).toBe(rec.id);
    expect(await record('C-2')).toBeUndefined();
  });

  it('reports a file uploaded by another person at check time, and links nothing', async () => {
    const id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Foreign' }), 201)).id;
    expect((await attach(colleague, id, 'theirs.png', png(6))).statusCode).toBe(201);
    expect((await attach(migrator, id, 'mine.png', png(7))).statusCode).toBe(201);
    const view = await ok(await addCsv(migrator, id, 'Foreign.csv', csv('C-1,Theirs,theirs.png,,', 'C-2,Mine,mine.png,,')), 201);
    await ok(await call(migrator, 'PUT', `/api/migrations/${id}/sources/${view.sources[0]!.id}/mapping`, mapping(PHOTO)));
    const checked = await check(id);
    expect(checked.check!.problems.map((p) => [p.row, p.message])).toEqual([[2, "File 'theirs.png' was uploaded by another person; upload again"]]);
    expect(checked.check).toMatchObject({ ready: 1, invalid: 1 });
    const done = await run(id);
    expect(await failures(done)).toEqual(["File 'theirs.png' was uploaded by another person; upload again"]);
    expect((await fileOf(id, 'theirs.png')).record_id).toBeNull();
    expect((await fileOf(id, 'mine.png')).record_id).not.toBeNull();
  });

  it('fails a row whose file was not uploaded (the default) and skips it with a warning on request', async () => {
    const text = csv('C-1,Has,a.png,,', 'C-2,Lacks,nope.png,,', 'C-3,Also,nope.png,,', 'C-4,More,gone.png,,');
    const failing = await setup('Missing fail', text, PHOTO, [['a.png', png(8)]]);
    const c1 = await check(failing.id);
    expect(c1.check!.problems.map((p) => [p.row, p.message, p.column])).toEqual([
      [3, "File 'nope.png' was not uploaded", 'Photo'],
      [4, "File 'nope.png' was not uploaded", 'Photo'],
      [5, "File 'gone.png' was not uploaded", 'Photo'],
    ]);
    expect(c1.check).toMatchObject({ ready: 1, invalid: 3, warnings: [] });
    const done1 = await run(failing.id);
    expect(done1.sources[0]!.counts).toMatchObject({ created: 1, failed: 3 });
    expect(await failures(done1)).toEqual(["File 'nope.png' was not uploaded", "File 'nope.png' was not uploaded", "File 'gone.png' was not uploaded"]);

    const skipping = await setup('Missing skip', text.replace(/C-/g, 'S-'), { photo: { column: 'Photo', onMissing: 'skip' } }, [['a.png', png(9)]]);
    const c2 = await check(skipping.id);
    expect(c2.check).toMatchObject({ ready: 4, invalid: 0 });
    expect(c2.check!.problems).toEqual([]);
    expect(c2.check!.warnings).toEqual([
      { kind: 'missing-attachments', sourceId: skipping.sources[0]!.id, fileName: 'Missing skip.csv', column: 'Photo', count: 2, samples: ['nope.png', 'gone.png'] },
    ]);
    const done2 = await run(skipping.id);
    expect(done2.sources[0]!.counts).toEqual({ created: 4, updated: 0, failed: 0, warned: 3 });
    expect((await record('S-1'))!.data.photo).toBeTruthy();
    expect((await record('S-2'))!.data.photo).toBeUndefined();
  });

  it('lists at most five missing names in the warning', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => `M-${i},N${i},file-${i}.png,,`);
    const view = await setup('Many missing', csv(...rows), { photo: { column: 'Photo', onMissing: 'skip' } });
    const w1 = (await check(view.id)).check!.warnings;
    expect(w1).toHaveLength(1);
    expect(w1[0]).toMatchObject({ kind: 'missing-attachments', count: 8 });
    expect(w1[0]!.samples).toHaveLength(5);
  });
});

describe('clean-up', () => {
  const age = (ids: string[]) => sql(`update file_object set created_at = now() - interval '25 hours' where id = any($1::uuid[])`, [ids]);

  it('keeps an unlinked attachment through the 24-hour clean-up, and never removes a file a record holds', async () => {
    const view = await setup('Cleanup', csv('K-1,Kept,linked.png,,'), PHOTO, [['linked.png', png(11)], ['waiting.png', png(12)]]);
    const stray = (await w.platform.files.upload(w.as(w.ngoA, migrator), { body: [png(13)], name: 'stray.png' })).id;
    const waiting = await fileOf(view.id, 'waiting.png');
    await check(view.id);
    await run(view.id);
    const linked = await fileOf(view.id, 'linked.png');
    expect(linked.record_id).not.toBeNull();
    await age([waiting.id, linked.id, stray]);

    await w.platform.files.cleanup(w.ngoA, 100);

    expect((await fileOf(view.id, 'waiting.png')).deleted_at).toBeNull();
    expect(onDisk(waiting.storage_key)).toBe(true);
    expect((await fileOf(view.id, 'linked.png')).deleted_at).toBeNull();
    expect((await sql<{ deleted_at: Date | null }>(`select deleted_at from file_object where id = $1`, [stray]))[0]!.deleted_at).not.toBeNull();

    // Once the attachment is removed, the same unlinked file is ordinary again and goes with the next clean-up.
    await sql(`delete from migration_attachment where profile_id = $1 and path = 'waiting.png'`, [view.id]);
    await w.platform.files.cleanup(w.ngoA, 100);
    expect((await sql<{ deleted_at: Date | null }>(`select deleted_at from file_object where id = $1`, [waiting.id]))[0]!.deleted_at).not.toBeNull();
  });
});

describe('purge', () => {
  it('deletes unlinked attachments with their bytes and the rows, and leaves files a record holds', async () => {
    const view = await setup('Purge files', csv('P-1,Held,held.png,,'), PHOTO, [['held.png', png(14)], ['spare.png', png(15)]]);
    await check(view.id);
    const done = await run(view.id);
    const held = await fileOf(view.id, 'held.png');
    const spare = await fileOf(view.id, 'spare.png');
    expect(done.attachments.count).toBe(2);
    expect(onDisk(spare.storage_key)).toBe(true);

    const purged = await ok(await call(migrator, 'POST', `/api/migrations/${view.id}/purge`));
    expect(purged.purgedAt).not.toBeNull();
    expect(purged.attachments).toEqual({ count: 0, bytes: 0 });
    expect(await count(`select count(*)::int as n from migration_attachment where profile_id = $1`, [view.id])).toBe(0);
    expect((await sql<{ deleted_at: Date | null }>(`select deleted_at from file_object where id = $1`, [spare.id]))[0]!.deleted_at).not.toBeNull();
    expect(onDisk(spare.storage_key)).toBe(false);
    expect(onDisk(held.storage_key)).toBe(true);
    expect((await sql<{ record_id: string | null; deleted_at: Date | null }>(`select record_id, deleted_at from file_object where id = $1`, [held.id]))[0]).toMatchObject({ deleted_at: null });
    expect((await record('P-1'))!.data.photo).toBe(held.id);
    expect((await call(migrator, 'GET', `/api/migrations/${view.id}/attachments`)).json()).toEqual({ items: [], total: 0 });
  });

  it('purges attachments of a profile that has only attachments, and the automatic purge does too', async () => {
    const id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Only files' }), 201)).id;
    await attach(migrator, id, 'only.png', png(16));
    const only = await fileOf(id, 'only.png');
    const purged = await ok(await call(migrator, 'POST', `/api/migrations/${id}/purge`));
    expect(purged.attachments.count).toBe(0);
    expect(onDisk(only.storage_key)).toBe(false);

    const view = await setup('Auto purge', csv('A-1,Auto,auto.png,,'), PHOTO, [['auto.png', png(17)], ['left.png', png(18)]]);
    await check(view.id);
    await run(view.id);
    const left = await fileOf(view.id, 'left.png');
    await sql(`update migration_profile set updated_at = now() - interval '31 days' where id = $1`, [view.id]);
    await w.platform.tick();
    expect(await count(`select count(*)::int as n from migration_attachment where profile_id = $1`, [view.id])).toBe(0);
    expect(onDisk(left.storage_key)).toBe(false);
  });
});
