import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { MIGRATION_RETENTION_DAYS, type ProfileView } from '../src/application/migration/migration-service.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { parseCsv } from '../src/infrastructure/transfer/csv.js';
import { createWorld, type TestWorld } from './helpers.js';

/** Retention and redaction of a data migration's uploaded files, samples and failed-row cells. */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;

const PAN = 'ABCDE1234F';
const NOTE = 'private-note-77';
const CSV = ['Id,Name,PAN,Notes,City', 'P-1,Asha,AAAAA1111A,hello,Pune', `P-2,,${PAN},${NOTE},Nashik`, `P-3,,${PAN},${NOTE},Mumbai`].join('\r\n');
const MAP = { targets: [{ key: 'p', type: 'patron', oldId: 'Id', fields: { name: 'Name', pan: 'PAN', notes: 'Notes', city: 'City' } }] };

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
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(migrator), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const addFile = (id: string, name: string, csv: string) =>
  app.inject({
    method: 'POST',
    url: `/api/migrations/${id}/sources`,
    headers: { ...headers(migrator), 'content-type': 'text/csv', 'x-file-name': encodeURIComponent(name) },
    payload: Buffer.from(csv),
  });
const sql = async <T extends object>(text: string, args: unknown[] = []) => w.platform.db.asSystem((tx) => tx.query<T>(text, args));
const count = async (text: string, args: unknown[] = []) => Number((await sql<{ n: number }>(text, args))[0]!.n);

/** A profile with the file added, mapped and checked, not yet run. */
async function checked(name: string): Promise<ProfileView> {
  const id = (await ok(await call('POST', '/api/migrations', { name }), 201)).id;
  let view = await ok(await addFile(id, `${name}.csv`, CSV), 201);
  view = await ok(await call('PUT', `/api/migrations/${id}/sources/${view.sources[0]!.id}/mapping`, MAP));
  return ok(await call('POST', `/api/migrations/${id}/check`));
}
async function finished(name: string): Promise<ProfileView> {
  const view = await checked(name);
  await ok(await call('POST', `/api/migrations/${view.id}/run`), 202);
  await w.platform.jobs.runOnce();
  return ok(await call('GET', `/api/migrations/${view.id}`));
}
const fileOf = async (view: ProfileView) =>
  (await sql<{ storage_key: string; deleted_at: Date | null }>(`select f.storage_key, f.deleted_at from migration_source s join file_object f on f.id = s.file_id where s.id = $1`, [view.sources[0]!.id]))[0]!;
const onDisk = (key: string) => existsSync(join(w.filesDir!, ...key.split('/')));
const audits = (action: string, id: string) => count(`select count(*)::int as n from audit_event where action = $1 and entity_id = $2`, [action, id]);

let redacted: ProfileView;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  migrator = await member('retainer', ['data:migrate', 'record:patron:*']);
  await w.platform.definitions.saveDraft(w.as(w.ngoA), 'recordType', {
    key: 'patron',
    label: 'Patron',
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'pan', label: 'PAN', type: 'text', sensitive: true },
      { key: 'notes', label: 'Notes', type: 'text', personal: true },
      { key: 'city', label: 'City', type: 'text' },
    ],
  } as never);
  await w.platform.definitions.publish(w.as(w.ngoA), 'recordType', 'patron');
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('redaction', () => {
  it('blanks samples of sensitive and personal columns once the mapping is saved, and keeps the others', async () => {
    const id = (await ok(await call('POST', '/api/migrations', { name: 'Redaction' }), 201)).id;
    let view = await ok(await addFile(id, 'people.csv', CSV), 201);
    const samples = (v: ProfileView) => Object.fromEntries(v.sources[0]!.columns.map((c) => [c.name, c.samples]));
    expect(samples(view).PAN).toContain(PAN);
    view = await ok(await call('PUT', `/api/migrations/${id}/sources/${view.sources[0]!.id}/mapping`, MAP));
    expect(samples(view)).toMatchObject({ Id: ['P-1', 'P-2', 'P-3'], Name: ['Asha'], PAN: [], Notes: [], City: ['Pune', 'Nashik', 'Mumbai'] });
    await ok(await call('POST', `/api/migrations/${id}/check`));
    await ok(await call('POST', `/api/migrations/${id}/run`), 202);
    await w.platform.jobs.runOnce();
    redacted = await ok(await call('GET', `/api/migrations/${id}`));
    expect(redacted.sources[0]!.counts).toEqual({ created: 1, updated: 0, failed: 2 });
  });

  it('stores failed rows without the cells of sensitive columns and keeps the rest', async () => {
    const items = await sql<{ data: { cells: string[] } }>(`select data from job_item where job_id = $1 and status = 'failed' order by seq`, [redacted.jobId]);
    expect(items.map((i) => i.data.cells)).toEqual([
      ['P-2', '', '', NOTE, 'Nashik'],
      ['P-3', '', '', NOTE, 'Mumbai'],
    ]);
  });

  it('leaves a sensitive value in no migration_source, job_item or audit row', async () => {
    for (const table of ['migration_source', 'job_item', 'audit_event', 'outbox_event']) {
      expect(await count(`select count(*)::int as n from ${table} where ${table}::text like '%' || $1 || '%'`, [PAN]), table).toBe(0);
    }
  });

  it('blanks cells already stored when a later mapping marks their column sensitive', async () => {
    const view = await finished('Later redaction');
    const pledge = { targets: [{ key: 'p', type: 'patron', oldId: 'Id', fields: { name: 'Name', pan: 'PAN', city: 'City' } }] };
    // Notes is personal, not sensitive: its cells stay in failed rows. Remapping Notes to a sensitive field blanks them.
    await ok(await call('PUT', `/api/migrations/${view.id}/sources/${view.sources[0]!.id}/mapping`, pledge));
    const items = await sql<{ data: { cells: string[] } }>(`select data from job_item where job_id = $1 and status = 'failed' order by seq`, [view.jobId]);
    expect(items.map((i) => i.data.cells[3])).toEqual([NOTE, NOTE]);
    await ok(await call('PUT', `/api/migrations/${view.id}/sources/${view.sources[0]!.id}/mapping`, { targets: [{ key: 'p', type: 'patron', oldId: 'Id', fields: { name: 'Name', pan: 'Notes' } }] }));
    const after = await sql<{ data: { cells: string[] } }>(`select data from job_item where job_id = $1 and status = 'failed' order by seq`, [view.jobId]);
    expect(after.map((i) => i.data.cells)).toEqual([
      ['P-2', '', '', '', 'Nashik'],
      ['P-3', '', '', '', 'Mumbai'],
    ]);
  });
});

describe('failed rows download', () => {
  it('writes an audit event each time failed.csv is downloaded', async () => {
    const view = await finished('Download');
    expect(await audits('migration.failed_rows_downloaded', view.id)).toBe(0);
    const res = await call('GET', `/api/migrations/${view.id}/sources/${view.sources[0]!.id}/failed.csv`);
    expect(res.statusCode, res.body).toBe(200);
    expect(parseCsv(res.body)).toEqual([
      ['Id', 'Name', 'PAN', 'Notes', 'City', 'Reason'],
      ['P-2', '', '', NOTE, 'Nashik', 'Name is required'],
      ['P-3', '', '', NOTE, 'Mumbai', 'Name is required'],
    ]);
    expect(await audits('migration.failed_rows_downloaded', view.id)).toBe(1);
    await call('GET', `/api/migrations/${view.id}/sources/${view.sources[0]!.id}/failed.csv`);
    expect(await audits('migration.failed_rows_downloaded', view.id)).toBe(2);
    const [row] = await sql<{ actor_id: string; after: { fileName: string } }>(`select actor_id, after from audit_event where action = 'migration.failed_rows_downloaded' and entity_id = $1 limit 1`, [view.id]);
    expect(row).toMatchObject({ actor_id: migrator.id, after: { fileName: 'Download.csv' } });
  });
});

describe('purge', () => {
  it('refuses a running migration', async () => {
    const view = await checked('Busy');
    await ok(await call('POST', `/api/migrations/${view.id}/run`), 202);
    const res = await call('POST', `/api/migrations/${view.id}/purge`);
    expect(res.statusCode, res.body).toBe(409);
    expect((await fileOf(view)).deleted_at).toBeNull();
    await w.platform.jobs.runOnce();
  });

  it('needs the migration permission', async () => {
    const view = await finished('Guarded');
    const other = await member('nomigrate', ['record:patron:*']);
    const res = await app.inject({ method: 'POST', url: `/api/migrations/${view.id}/purge`, headers: headers(other) });
    expect(res.statusCode).toBe(403);
    expect((await fileOf(view)).deleted_at).toBeNull();
  });

  it('deletes the files, samples and failed cells, and stamps purged_at', async () => {
    const view = await finished('Purged');
    const before = await fileOf(view);
    expect(onDisk(before.storage_key)).toBe(true);
    expect(view.purgedAt).toBeNull();

    const purged = await ok(await call('POST', `/api/migrations/${view.id}/purge`));
    expect(purged.purgedAt).not.toBeNull();
    expect(purged.status).toBe('done');
    expect(purged.sources[0]).toMatchObject({ purgedAt: expect.any(String), counts: expect.objectContaining({ failed: 2 }) });
    expect(purged.sources[0]!.columns.every((c) => c.samples.length === 0)).toBe(true);
    expect(purged.sources[0]!.columns.map((c) => c.name)).toEqual(['Id', 'Name', 'PAN', 'Notes', 'City']);

    expect((await fileOf(view)).deleted_at).not.toBeNull();
    expect(onDisk(before.storage_key)).toBe(false);
    expect(await count(`select count(*)::int as n from job_item where job_id = $1 and data->'cells' is not null`, [view.jobId])).toBe(0);
    expect(await count(`select count(*)::int as n from job_item where job_id = $1 and status = 'failed'`, [view.jobId])).toBe(2);
    expect(await count(`select count(*)::int as n from job_item where job_id = $1 and data::text like '%' || $2 || '%'`, [view.jobId, NOTE])).toBe(0);
    expect(await count(`select count(*)::int as n from migration_source where profile_id = $1 and purged_at is not null`, [view.id])).toBe(1);
    expect(await audits('migration.purged', view.id)).toBe(1);

    const download = await call('GET', `/api/migrations/${view.id}/sources/${view.sources[0]!.id}/failed.csv`);
    expect(download.statusCode).toBe(409);
    expect(download.json().message).toMatch(/deleted/);
  });

  it('is repeatable and changes nothing the second time', async () => {
    const view = await finished('Twice');
    const first = await ok(await call('POST', `/api/migrations/${view.id}/purge`));
    const second = await ok(await call('POST', `/api/migrations/${view.id}/purge`));
    expect(second.purgedAt).toBe(first.purgedAt);
    expect(second.sources[0]!.purgedAt).toBe(first.sources[0]!.purgedAt);
    expect(await audits('migration.purged', view.id)).toBe(1);
  });

  it('cannot be checked or run until the purged file is removed and uploaded again', async () => {
    const view = await checked('Re-upload');
    const purged = await ok(await call('POST', `/api/migrations/${view.id}/purge`));
    expect(purged.status).toBe('draft');
    expect(purged.check).toBeNull();
    const refused = await call('POST', `/api/migrations/${view.id}/check`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/was deleted when the migration data was purged.*upload it again/);
    expect((await call('POST', `/api/migrations/${view.id}/run`)).statusCode).toBe(409);

    await ok(await call('DELETE', `/api/migrations/${view.id}/sources/${view.sources[0]!.id}`));
    let again = await ok(await addFile(view.id, 'Re-upload.csv', CSV), 201);
    again = await ok(await call('PUT', `/api/migrations/${view.id}/sources/${again.sources[0]!.id}/mapping`, MAP));
    again = await ok(await call('POST', `/api/migrations/${view.id}/check`));
    expect(again.status).toBe('checked');
    expect(again.sources[0]!.purgedAt).toBeNull();
    await ok(await call('POST', `/api/migrations/${view.id}/run`), 202);
    await w.platform.jobs.runOnce();
    expect((await ok(await call('GET', `/api/migrations/${view.id}`))).status).toBe('done');
  });
});

describe('automatic purge', () => {
  const age = (id: string, days: number) =>
    sql(`update migration_profile set updated_at = now() - make_interval(days => $2) where id = $1`, [id, days]);

  it('purges a finished or failed migration 30 days after it finished, and not before', async () => {
    expect(MIGRATION_RETENTION_DAYS).toBe(30);
    const recent = await finished('Recent');
    const old = await finished('Old');
    const draft = await checked('Still draft');
    const cancelled = await checked('Cancelled');
    await ok(await call('POST', `/api/migrations/${cancelled.id}/run`), 202);
    await ok(await call('POST', `/api/migrations/${cancelled.id}/cancel`));
    await w.platform.jobs.runOnce();
    expect((await ok(await call('GET', `/api/migrations/${cancelled.id}`))).status).toBe('failed');
    await age(recent.id, 29);
    await age(old.id, 31);
    await age(draft.id, 400);
    await age(cancelled.id, 31);

    const key = (await fileOf(old)).storage_key;
    await w.platform.tick();

    const state = async (id: string) => (await ok(await call('GET', `/api/migrations/${id}`))).purgedAt;
    expect(await state(old.id)).not.toBeNull();
    expect(await state(cancelled.id)).not.toBeNull();
    expect(await state(recent.id)).toBeNull();
    expect(await state(draft.id)).toBeNull();
    expect((await fileOf(old)).deleted_at).not.toBeNull();
    expect(onDisk(key)).toBe(false);
    expect((await fileOf(recent)).deleted_at).toBeNull();
    expect(await count(`select count(*)::int as n from job_item where job_id = $1 and data->'cells' is not null`, [old.jobId])).toBe(0);
    expect(await audits('migration.purged', old.id)).toBe(1);
    expect(await count(`select count(*)::int as n from job where kind = 'migration.purge' and status = 'done'`)).toBe(1);
  });
});
