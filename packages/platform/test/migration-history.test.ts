import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../src/application/migration/migration-service.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { createWorld, type TestWorld } from './helpers.js';

/**
 * Legacy dates and legacy statuses of migrated records: the dates are the originals, the status is set on
 * create without a transition. A receipt rule that fires on a migrated status issues no receipt.
 */

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;
let noStateMigrator: Actor;

const PERMISSIONS = ['data:migrate', 'data:migrate:state', 'members:manage', 'record:histbase:*', 'record:histpaid:*'];

async function member(name: string, permissions: string[]): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) => tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name}@example.org`, name]));
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
const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};

const STATES = [
  { key: 'open', label: 'Open' },
  { key: 'paid', label: 'Paid' },
  { key: 'cancelled', label: 'Cancelled' },
];
const FLOW = (key: string, recordType: string) => ({ key, recordType, initial: 'open', states: STATES, transitions: [{ key: 'pay', label: 'Pay', from: ['open'], to: 'paid' }] });

/** One profile with one file, mapped as given, checked and (unless `run` is false) run. */
async function profile(actor: Actor, file: { name: string; csv: string; mapping: unknown }, run = true) {
  const created = await ok(await call(actor, 'POST', '/api/migrations', { name: `History ${Math.random().toString(36).slice(2, 8)}` }), 201);
  const added = await app.inject({
    method: 'POST',
    url: `/api/migrations/${created.id}/sources`,
    headers: { ...headers(actor), 'content-type': 'text/csv', 'x-file-name': file.name },
    payload: Buffer.from(file.csv),
  });
  const source = (await ok(added, 201)).sources.find((s) => s.fileName === file.name)!;
  await ok(await call(actor, 'PUT', `/api/migrations/${created.id}/sources/${source.id}/mapping`, file.mapping));
  await ok(await call(actor, 'POST', `/api/migrations/${created.id}/check`), 202);
  await w.platform.jobs.runOnce();
  const check = await ok(await call(actor, 'GET', `/api/migrations/${created.id}`));
  if (!run) return { id: created.id, check, done: check };
  await ok(await call(actor, 'POST', `/api/migrations/${created.id}/run`), 202);
  await w.platform.jobs.runOnce({ timeBudgetMs: 280_000 });
  return { id: created.id, check, done: await ok(await call(actor, 'GET', `/api/migrations/${created.id}`)) };
}

const CSV = (rows: string[][], header = ['Code', 'Title', 'Status', 'Created', 'Updated']) => [header, ...rows].map((r) => r.join(',')).join('\r\n');
const ROW_MAP = (type: string, extra: Record<string, unknown> = {}) => ({
  targets: [{ key: 'h', type, oldId: 'Code', fields: { name: 'Title' }, ...extra }],
});
const STATE = { column: 'Status', map: { Open: 'open', Paid: 'paid', Cancelled: 'cancelled' } };
const DATES = { createdAt: 'Created', updatedAt: 'Updated' };

/** The stored rows of a record type, by name: status and the two stored timestamps as ISO text. */
async function stored(type: string) {
  const rows = await q<{ name: string; status: string; created_at: Date; updated_at: Date; id: string }>(
    `select data->>'name' as name, status, created_at, updated_at, id from record where tenant_id = $1 and type_key = $2 and deleted_at is null`,
    [w.ngoA, type],
  );
  return Object.fromEntries(rows.map((r) => [r.name, { status: r.status, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), id: r.id }]));
}
const countOf = async (sql: string, args: unknown[]) => Number((await q<{ n: number }>(sql, args))[0]!.n);

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  migrator = await member('history-migrator', PERMISSIONS);
  noStateMigrator = await member('history-no-state', ['data:migrate', 'members:manage', 'record:histbase:*']);
  for (const key of ['histbase', 'histpaid']) {
    await publish('recordType', {
      key,
      label: key === 'histbase' ? 'Plain record' : 'Paid record',
      titleField: 'name',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'note', label: 'Note', type: 'text' },
        { key: 'amount', label: 'Amount', type: 'money' },
      ],
    });
    await publish('workflow', FLOW(`${key}Flow`, key));
  }
  // A receipt on the Paid status: a migrated record in that status issues none, and keeps its legacy receipt number.
  await publish('receiptRule', { key: 'histReceiptOnPaid', recordType: 'histpaid', whenStatus: 'paid', series: 'donation-receipt', amount: 'record.amount', date: 'today()' });
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('legacy dates and statuses', () => {
  it('creates each record in its mapped status with the original dates, and issues nothing', async () => {
    const csv = CSV([
      ['H-1', 'First', 'Open', '2026-03-14', '2026-03-20'],
      ['H-2', 'Second', 'Cancelled', '2026-02-01 10:30', '2026-02-02T09:00:00+05:30'],
    ]);
    const done = await profile(migrator, { name: 'history-1.csv', csv, mapping: ROW_MAP('histbase', { dates: DATES, state: STATE }) });
    expect(done.check.check).toMatchObject({ ready: 2, invalid: 0, problems: [] });
    expect(done.done.status).toBe('done');

    const rows = await stored('histbase');
    expect(rows.First).toMatchObject({ status: 'open', createdAt: '2026-03-14T00:00:00.000Z', updatedAt: '2026-03-20T00:00:00.000Z' });
    expect(rows.Second).toMatchObject({ status: 'cancelled', createdAt: '2026-02-01T10:30:00.000Z', updatedAt: '2026-02-02T03:30:00.000Z' });
    // No transition, posting or receipt ran for them.
    expect(await countOf(`select count(*)::int as n from receipt where tenant_id = $1 and record_id = any($2::uuid[])`, [w.ngoA, [rows.First!.id, rows.Second!.id]])).toBe(0);
    expect(await countOf(`select count(*)::int as n from journal_entry where tenant_id = $1 and source_record_id = any($2::uuid[])`, [w.ngoA, [rows.First!.id, rows.Second!.id]])).toBe(0);
  });

  it('migrates a status a receipt rule fires on, and issues no receipt for it', async () => {
    const csv = CSV([['P-1', 'Paid one', 'Paid', '2026-03-14', '2026-03-14']]);
    const file = { name: 'paid.csv', csv, mapping: ROW_MAP('histpaid', { dates: DATES, state: STATE }) };
    const { check, done } = await profile(migrator, file);
    expect(check.check).toMatchObject({ ready: 1, invalid: 0, problems: [] });
    expect(done.status).toBe('done');
    const rows = await stored('histpaid');
    expect(rows['Paid one']).toMatchObject({ status: 'paid', createdAt: '2026-03-14T00:00:00.000Z' });
    expect(await countOf(`select count(*)::int as n from receipt where tenant_id = $1 and record_id = $2`, [w.ngoA, rows['Paid one']!.id])).toBe(0);
  });

  it('a status no mapping names and a date that is no date are problems of their rows; the other rows still check', async () => {
    const csv = CSV([
      ['H-3', 'Lost one', 'Lost', '2026-03-01', '2026-03-01'],
      ['H-4', 'Bad date', 'Open', 'soon', '2026-03-01'],
      ['H-5', 'Good one', 'Open', '2026-03-01', '2026-03-02'],
    ]);
    const { check } = await profile(migrator, { name: 'bad-rows.csv', csv, mapping: ROW_MAP('histbase', { dates: DATES, state: STATE }) }, false);
    expect(check.check).toMatchObject({ rows: 3, ready: 1, invalid: 2 });
    const messages = check.check!.problems.map((p) => p.message);
    expect(messages).toContain("Status 'Lost' is not one of the statuses the mapping names");
    expect(messages).toContain("Created date 'soon' is not a date (use dd/mm/yyyy, yyyy-mm-dd or a date and time)");
  });

  it('a second file keeps the stored status and moves only the updated date', async () => {
    const before = await stored('histbase');
    const csv = CSV([['H-1', 'First', 'Cancelled', '2026-03-14', '2026-04-01']]);
    await profile(migrator, { name: 'history-2.csv', csv, mapping: ROW_MAP('histbase', { dates: DATES, state: STATE }) });
    const after = await stored('histbase');
    expect(after.First).toMatchObject({ id: before.First!.id, status: 'open', createdAt: '2026-03-14T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z' });
  });

  it('needs data:migrate:state to map a status, and the import permission alone is refused', async () => {
    const created = await ok(await call(noStateMigrator, 'POST', '/api/migrations', { name: 'No state permission' }), 201);
    const added = await app.inject({
      method: 'POST',
      url: `/api/migrations/${created.id}/sources`,
      headers: { ...headers(noStateMigrator), 'content-type': 'text/csv', 'x-file-name': 'nostate.csv' },
      payload: Buffer.from(CSV([['N-1', 'Nope', 'Open', '2026-03-01', '2026-03-01']])),
    });
    const source = (await ok(added, 201)).sources.find((s) => s.fileName === 'nostate.csv')!;
    const res = await call(noStateMigrator, 'PUT', `/api/migrations/${created.id}/sources/${source.id}/mapping`, ROW_MAP('histbase', { state: STATE }));
    expect(res.statusCode).toBe(403);
  });
});
