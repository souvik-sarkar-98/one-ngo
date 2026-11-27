import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../../../packages/platform/src/application/migration/migration-service.js';
import type { Actor } from '../../../packages/platform/src/infrastructure/postgres/db.js';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';

/** The check says what the run will do: fields copied from a record the migration creates, locked fields, unique values, optional targets. */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;

const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const call = (actor: Actor, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(actor), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const recordOf = async (typeKey: string, oldId: string) => {
  const rows = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`select r.id from migration_key k join record r on r.id = k.record_id where k.tenant_id = $1 and k.type_key = $2 and k.old_id = $3`, [w.ngoA, typeKey, oldId]),
  );
  if (!rows[0]) return null;
  return (await w.platform.records.query(w.as(w.ngoA), typeKey, { limit: 200 })).items.find((r) => r.id === rows[0]!.id) ?? null;
};

const CSV = (header: string[], rows: string[][]) => [header, ...rows].map((r) => r.join(',')).join('\r\n');
const DONORS = { targets: [{ key: 'donor', type: 'donor', oldId: 'DonorId', fields: { name: 'Name', email: 'Email', pan: 'PAN' }, refs: {} }] };
const GIFTS = {
  targets: [{ key: 'gift', type: 'donation', oldId: 'ReceiptNo', fields: { donorName: 'DonorName', donorEmail: 'DonorEmail', amount: 'Amount' }, refs: { donor: { column: 'DonorId' } } }],
};

interface Upload {
  name: string;
  csv: string;
  mapping: unknown;
}
/** One profile with the files, in order, each mapped; checked and (unless `run` is false) run. */
async function load(files: Upload[], options: { run?: boolean } = {}): Promise<{ check: ProfileView; done: ProfileView }> {
  const created = await ok(await call(migrator, 'POST', '/api/migrations', { name: `Matches ${files[0]!.name}` }), 201);
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
  if (options.run === false) return { check, done: check };
  await ok(await call(migrator, 'POST', `/api/migrations/${created.id}/run`), 202);
  await w.platform.jobs.runOnce({ timeBudgetMs: 280_000 });
  return { check, done: await ok(await call(migrator, 'GET', `/api/migrations/${created.id}`)) };
}
const countsOf = (p: ProfileView, fileName: string) => p.sources.find((s) => s.fileName === fileName)!.counts;
const checkOf = (p: ProfileView, fileName: string) => p.check!.sources.find((s) => s.fileName === fileName)!;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  const permissions = ['data:migrate', 'record:donor:*', 'record:donation:*'];
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ('check-matches@example.org', 'check-matches') returning id`),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, 'held-check-matches', 'held-check-matches', $2::text[])`, [w.ngoA, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, 'held-check-matches')`, [w.ngoA, u!.id]);
  });
  migrator = { id: u!.id, roles: [], permissions };
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('a check that matches its run', () => {
  it('fills fields copied from a donor the same migration creates, as the run copies them', async () => {
    const donors = CSV(['DonorId', 'Name', 'Email', 'PAN'], [['CP-1', 'Asha Rao', 'asha.cp@example.org', '']]);
    const gifts = CSV(['ReceiptNo', 'DonorId', 'DonorName', 'DonorEmail', 'Amount'], [
      ['CPG-1', 'CP-1', '', '', '500'],
      ['CPG-2', 'CP-1', 'Asha Rao', 'x@', '100'],
    ]);
    const l = await load([
      { name: 'copy-donors.csv', csv: donors, mapping: DONORS },
      { name: 'copy-gifts.csv', csv: gifts, mapping: GIFTS },
    ]);
    expect(checkOf(l.check, 'copy-gifts.csv')).toMatchObject({ ready: 2, invalid: 0, creates: 2 });
    expect(countsOf(l.done, 'copy-gifts.csv')).toEqual({ created: 2, updated: 0, failed: 0 });
    expect(await recordOf('donation', 'CPG-1')).toMatchObject({ data: { donorName: 'Asha Rao', donorEmail: 'asha.cp@example.org' } });
    expect(await recordOf('donation', 'CPG-2')).toMatchObject({ data: { donorEmail: 'asha.cp@example.org' } });
  });

  it('refuses a later row that changes a field locked on the record an earlier row creates, as the run would', async () => {
    const donors = CSV(['DonorId', 'Name', 'Email', 'PAN'], [['LK-1', 'Meena Iyer', '', '']]);
    const gifts = CSV(['ReceiptNo', 'DonorId', 'DonorName', 'DonorEmail', 'Amount'], [
      ['LKG-1', 'LK-1', '', '', '500'],
      ['LKG-1', 'LK-1', 'Someone Else', '', '600'],
      ['LKG-2', 'LK-1', '', '', '700'],
      ['LKG-2', 'LK-1', '', '', '750'],
    ]);
    const l = await load([
      { name: 'lock-donors.csv', csv: donors, mapping: DONORS },
      { name: 'lock-gifts.csv', csv: gifts, mapping: GIFTS },
    ]);
    expect(checkOf(l.check, 'lock-gifts.csv')).toMatchObject({ ready: 3, invalid: 1, creates: 2, updates: 1 });
    expect(l.check.check!.problems).toMatchObject([{ row: 3, field: 'donorName', fileName: 'lock-gifts.csv' }]);
    expect(countsOf(l.done, 'lock-gifts.csv')).toEqual({ created: 2, updated: 1, failed: 1 });
    expect(await recordOf('donation', 'LKG-2')).toMatchObject({ data: { donorName: 'Meena Iyer', amount: 750 } });
  });

  it('refuses a unique value another record of the same migration takes, as the run would', async () => {
    const donors = CSV(['DonorId', 'Name', 'Email', 'PAN'], [
      ['UQ-1', 'First Holder', '', 'PQRST1234U'],
      ['UQ-2', 'Second Holder', '', 'PQRST1234U'],
      ['UQ-1', 'First Holder Again', '', 'PQRST1234U'],
    ]);
    const l = await load([{ name: 'unique-donors.csv', csv: donors, mapping: DONORS }]);
    expect(checkOf(l.check, 'unique-donors.csv')).toMatchObject({ ready: 2, invalid: 1, creates: 1, updates: 1 });
    expect(l.check.check!.problems).toMatchObject([{ row: 3, field: 'pan', column: 'PAN' }]);
    expect(l.check.check!.problems[0]!.message).toBe('Another donor in this migration already has this PAN.');
    expect(countsOf(l.done, 'unique-donors.csv')).toEqual({ created: 1, updated: 1, failed: 1 });
    expect(await recordOf('donor', 'UQ-2')).toBeNull();
  });

  it('warns about an optional target it leaves out, in the check and the run', async () => {
    const combined = CSV(['DonorCode', 'DonorName', 'GiftNo', 'GiftAmount'], [
      ['OP-1', 'Alpha Trust', 'OPG-1', '100'],
      ['OP-2', 'Beta Trust', 'OPG-2', 'abc'],
      ['OP-3', 'Gamma Trust', '', ''],
    ]);
    const mapping = {
      targets: [
        { key: 'donor', type: 'donor', oldId: 'DonorCode', fields: { name: 'DonorName' }, refs: {} },
        { key: 'gift', type: 'donation', oldId: 'GiftNo', fields: { amount: 'GiftAmount' }, refs: { donor: { target: 'donor' } }, required: false },
      ],
    };
    const l = await load([{ name: 'optional-gift.csv', csv: combined, mapping }]);
    expect(checkOf(l.check, 'optional-gift.csv')).toMatchObject({ ready: 3, invalid: 0, creates: 4 });
    const left = l.check.check!.warnings.filter((x) => x.kind === 'optional-target-left-out');
    expect(left).toMatchObject([{ fileName: 'optional-gift.csv', target: 'gift', count: 1 }]);
    expect(left[0]!.samples).toHaveLength(1);
    expect(left[0]!.samples[0]).toMatch(/^Row 3: Amount/);
    expect(countsOf(l.done, 'optional-gift.csv')).toEqual({ created: 4, updated: 0, failed: 0, warned: 1 });
    expect(await recordOf('donation', 'OPG-1')).toMatchObject({ data: { donorName: 'Alpha Trust', amount: 100 } });
    expect(await recordOf('donation', 'OPG-2')).toBeNull();
    expect(await recordOf('donor', 'OP-2')).not.toBeNull();
  });
});
