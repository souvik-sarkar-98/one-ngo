import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ProfileView } from '../src/application/migration/migration-service.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';
import { parseCsv } from '../src/infrastructure/transfer/csv.js';
import type { DefinitionKind } from '../src/runtime/definitions/types.js';
import { createWorld, today, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;
let migrator: Actor;
let noBooks: Actor;

const RECORDS = ['record:supporter:*', 'record:pledge:*'];

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
async function member(name: string, permissions: string[]): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name}@example.org`, name]),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    // Jobs act with the person's current roles, so the permissions must be held through a role.
    await tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, $2, $2, $3::text[])`, [w.ngoA, `held-${name}`, permissions]);
    await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [w.ngoA, u!.id, `held-${name}`]);
  });
  return { id: u!.id, roles: [], permissions };
}
const headers = (actor: Actor, tenant = w.ngoA) => ({ 'x-dev-tenant': tenant, 'x-dev-actor': JSON.stringify(actor) });
const call = (actor: Actor, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(actor), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
async function ok(res: Awaited<ReturnType<typeof call>>, status = 200): Promise<ProfileView> {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as ProfileView;
}
const addFile = (actor: Actor, id: string, name: string, csv: string) =>
  app.inject({
    method: 'POST',
    url: `/api/migrations/${id}/sources`,
    headers: { ...headers(actor), 'content-type': 'text/csv', 'x-file-name': encodeURIComponent(name) },
    payload: Buffer.from(csv),
  });
const source = (view: ProfileView, name: string) => view.sources.find((s) => s.fileName === name)!;
const count = async (sql: string, args: unknown[] = []) => Number((await w.platform.db.asSystem((tx) => tx.query<{ n: number }>(sql, args)))[0]!.n);
const all = async (type: string) => (await w.platform.records.query(w.as(w.ngoA), type, { limit: 200, sort: { field: 'createdAt', dir: 'asc' } })).items;
const byOldId = async (type: string, oldId: string) =>
  (await w.platform.db.asSystem((tx) => tx.query<{ record_id: string }>(`select record_id from migration_key where tenant_id = $1 and type_key = $2 and old_id = $3`, [w.ngoA, type, oldId])))[0]
    ?.record_id;

const SUPPORTERS = ['DonorId,Full Name,Mail,Legacy code', 'D-1,Asha Rao,asha@example.org,X19', 'D-2,Ravi Kumar,,X20', 'D-3,,nobody@example.org,X21'].join('\r\n');
const GIFTS = ['TxnNo,DonorId,Amount', 'T-1,D-1,"1,000"', 'T-2,D-2,50', 'T-3,D-9,10'].join('\r\n');
const COMBINED = ['Donor code,Name,Txn,Gift amount', 'D-4,Meena,T-4,25', 'D-5,Kiran,,', 'D-6,,T-6,30'].join('\n');

const SUPPORTER_MAP = { targets: [{ key: 'supporter', type: 'supporter', oldId: 'DonorId', fields: { name: 'Full Name', email: 'Mail' } }] };
const GIFT_MAP = { targets: [{ key: 'pledge', type: 'pledge', oldId: 'TxnNo', fields: { amount: 'Amount' }, refs: { supporter: { column: 'DonorId' } } }] };
const COMBINED_MAP = {
  targets: [
    { key: 'supporter', type: 'supporter', oldId: 'Donor code', fields: { name: 'Name' } },
    { key: 'gift', type: 'pledge', oldId: 'Txn', fields: { amount: 'Gift amount' }, refs: { supporter: { target: 'supporter' } }, required: false },
  ],
};

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  migrator = await member('migrator', ['data:migrate', 'data:migrate:books', ...RECORDS]);
  noBooks = await member('nobooks', ['data:migrate', ...RECORDS]);
  await publish('recordType', {
    key: 'supporter',
    label: 'Supporter',
    titleField: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'photo', label: 'Photo', type: 'file' },
    ],
  });
  await publish('recordType', {
    key: 'pledge',
    label: 'Pledge',
    titleField: 'amount',
    numbering: { sequence: 'pledge', format: 'PLG/{seq:4}', reset: 'never' },
    fields: [
      { key: 'supporter', label: 'Supporter', type: 'reference', referenceType: 'supporter', required: true },
      { key: 'amount', label: 'Amount', type: 'money', required: true, min: 1 },
      { key: 'tag', label: 'Tag', type: 'text' },
    ],
  });
  await publish('automation', {
    key: 'pledgeStamp',
    recordType: 'pledge',
    trigger: { event: 'created' },
    actions: [{ type: 'setFields', values: { tag: "'auto'" } }],
  });
});
afterAll(async () => {
  await app?.close();
  await w?.close();
});

describe('data migration', () => {
  let id: string;

  it('keeps any CSV as it arrived and refuses what is not a CSV', async () => {
    id = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Legacy extract' }), 201)).id;
    await ok(await addFile(migrator, id, 'gifts.csv', GIFTS), 201);
    await ok(await addFile(migrator, id, 'supporters.csv', SUPPORTERS), 201);
    const view = await ok(await addFile(migrator, id, 'combined.csv', COMBINED), 201);
    expect(view.sources.map((s) => [s.fileName, s.rowCount, s.mapping])).toEqual([
      ['gifts.csv', 3, null],
      ['supporters.csv', 3, null],
      ['combined.csv', 3, null],
    ]);
    expect(source(view, 'supporters.csv').columns.map((c) => c.name)).toEqual(['DonorId', 'Full Name', 'Mail', 'Legacy code']);
    expect(source(view, 'supporters.csv').columns[1]!.samples).toEqual(['Asha Rao', 'Ravi Kumar']);
    expect((await addFile(migrator, id, 'ledger.xlsx', 'a,b\n1,2')).statusCode).toBe(422);
    expect((await addFile(migrator, id, 'gifts.csv', GIFTS)).statusCode).toBe(409);
    expect((await call(migrator, 'GET', '/api/migrations')).json().items).toEqual([expect.objectContaining({ id, name: 'Legacy extract', status: 'draft', files: 3 })]);
  });

  it('maps files onto record types, splits a row into two, and moves a file after the one it looks up', async () => {
    let view = await ok(await call(migrator, 'GET', `/api/migrations/${id}`));
    view = await ok(await call(migrator, 'PUT', `/api/migrations/${id}/sources/${source(view, 'gifts.csv').id}/mapping`, GIFT_MAP));
    expect(view.sources.map((s) => s.fileName)).toEqual(['gifts.csv', 'supporters.csv', 'combined.csv']);
    view = await ok(await call(migrator, 'PUT', `/api/migrations/${id}/sources/${source(view, 'supporters.csv').id}/mapping`, SUPPORTER_MAP));
    expect(view.sources.map((s) => s.fileName)).toEqual(['supporters.csv', 'gifts.csv', 'combined.csv']);
    view = await ok(await call(migrator, 'PUT', `/api/migrations/${id}/sources/${source(view, 'combined.csv').id}/mapping`, COMBINED_MAP));
    expect(view.sources.map((s) => s.fileName)).toEqual(['supporters.csv', 'combined.csv', 'gifts.csv']);
    expect(source(view, 'combined.csv').mapping!.targets.map((t) => [t.type, t.required])).toEqual([
      ['supporter', true],
      ['pledge', false],
    ]);

    const bad = await call(migrator, 'PUT', `/api/migrations/${id}/sources/${source(view, 'supporters.csv').id}/mapping`, {
      targets: [{ key: 's', type: 'supporter', oldId: 'DonorId', fields: { name: 'Full Name', photo: 'Mail' } }],
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().issues).toEqual([{ path: '/targets/0/fields/photo', message: "'Photo' cannot be filled from a file" }]);

    const backwards = [source(view, 'gifts.csv').id, source(view, 'supporters.csv').id, source(view, 'combined.csv').id];
    const refused = await call(migrator, 'PUT', `/api/migrations/${id}/order`, { sourceIds: backwards });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().issues[0].message).toBe('gifts.csv looks up records from supporters.csv, so it must come after it');
  });

  it('checks every row in load order without saving anything', async () => {
    const before = await count(`select count(*)::int as n from record where type_key in ('supporter', 'pledge')`);
    const view = await ok(await call(migrator, 'POST', `/api/migrations/${id}/check`));
    expect(view.status).toBe('checked');
    expect(view.check).toMatchObject({ rows: 9, ready: 6, invalid: 3, creates: 7, updates: 0 });
    expect(view.check!.sources.map((s) => [s.fileName, s.ready, s.invalid, s.creates])).toEqual([
      ['supporters.csv', 2, 1, 2],
      ['combined.csv', 2, 1, 3],
      ['gifts.csv', 2, 1, 2],
    ]);
    expect(view.check!.problems.map((p) => [p.fileName, p.row, p.message])).toEqual([
      ['supporters.csv', 4, 'Name is required'],
      ['combined.csv', 4, 'Name is required'],
      ['gifts.csv', 4, "Supporter: nothing loaded has old id 'D-9'"],
    ]);
    expect(await count(`select count(*)::int as n from record where type_key in ('supporter', 'pledge')`)).toBe(before);
    expect(await count(`select count(*)::int as n from migration_key`)).toBe(0);
  });

  it('keeps the books balanced and needs their own permission', async () => {
    const unbalanced = await call(migrator, 'PUT', `/api/migrations/${id}/books`, {
      cutoverDate: today(),
      lines: [
        { accountCode: 'BANK', debit: '100' },
        { accountCode: 'DONATION_INCOME', credit: '99' },
      ],
    });
    expect(unbalanced.statusCode).toBe(422);
    expect((await call(noBooks, 'PUT', `/api/migrations/${id}/books`, { cutoverDate: today() })).statusCode).toBe(403);
    const view = await ok(
      await call(migrator, 'PUT', `/api/migrations/${id}/books`, {
        cutoverDate: today(),
        lines: [
          { accountCode: 'BANK', debit: '4,80,000'.replace(/,/g, '') },
          { accountCode: 'DONATION_INCOME', credit: '480000' },
        ],
        receipts: [{ series: 'donation-receipt', next: 2045 }],
      }),
    );
    expect(view.books).toEqual({
      cutoverDate: today(),
      lines: [
        { accountCode: 'BANK', debit: '480000.00' },
        { accountCode: 'DONATION_INCOME', credit: '480000.00' },
      ],
      receipts: [{ series: 'donation-receipt', next: 2045 }],
    });
    expect(view.status).toBe('checked');
  });

  it('runs quietly in order, one transaction per row, then applies the books once', async () => {
    const run = await ok(await call(migrator, 'POST', `/api/migrations/${id}/run`), 202);
    expect(run.status).toBe('running');
    expect((await call(migrator, 'POST', `/api/migrations/${id}/run`)).statusCode).toBe(409);
    expect((await call(migrator, 'PUT', `/api/migrations/${id}/order`, { sourceIds: run.sources.map((s) => s.id) })).statusCode).toBe(409);
    await w.platform.jobs.runOnce();

    const done = await ok(await call(migrator, 'GET', `/api/migrations/${id}`));
    expect(done.status).toBe('done');
    expect(done.sources.map((s) => [s.fileName, s.counts])).toEqual([
      ['supporters.csv', { created: 2, updated: 0, failed: 1 }],
      ['combined.csv', { created: 3, updated: 0, failed: 1 }],
      ['gifts.csv', { created: 2, updated: 0, failed: 1 }],
    ]);
    expect((await all('supporter')).map((r) => r.data.name)).toEqual(['Asha Rao', 'Ravi Kumar', 'Meena', 'Kiran']);
    const pledges = await all('pledge');
    expect(pledges.map((p) => [p.data.supporter, p.data.amount])).toEqual([
      [await byOldId('supporter', 'D-4'), 25],
      [await byOldId('supporter', 'D-1'), 1000],
      [await byOldId('supporter', 'D-2'), 50],
    ]);
    expect(await byOldId('supporter', 'D-6')).toBeUndefined();
    expect(await byOldId('pledge', 'T-6')).toBeUndefined();

    await w.platform.dispatcher.runOnce();
    expect((await all('pledge')).map((p) => p.data.tag ?? null)).toEqual([null, null, null]);

    expect(done.booksAppliedAt).not.toBeNull();
    expect(done.booksResult).toMatchObject({ receipts: [{ series: 'donation-receipt', next: 2045 }] });
    expect(await count(`select count(*)::int as n from journal_entry where tenant_id = $1 and memo = 'Opening balances (data migration)'`, [w.ngoA])).toBe(1);
    expect(await count(`select next_value::int as n from sequence_counter where tenant_id = $1 and key = 'receipt:donation-receipt'`, [w.ngoA])).toBe(2045);
    expect((await call(migrator, 'POST', `/api/migrations/${id}/books/apply`)).statusCode).toBe(409);

    const [note] = await w.platform.notifications.inbox(w.as(w.ngoA, migrator));
    expect(note).toMatchObject({ subject: 'Data migration finished', body: 'Data migration finished: 7 records created, 0 updated, 3 rows failed.', link: `/admin/migration/${id}/result` });
  });

  it('downloads one file’s failed rows as they were, with the reason', async () => {
    const view = await ok(await call(migrator, 'GET', `/api/migrations/${id}`));
    const res = await call(migrator, 'GET', `/api/migrations/${id}/sources/${source(view, 'gifts.csv').id}/failed.csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(parseCsv(res.body)).toEqual([
      ['TxnNo', 'DonorId', 'Amount', 'Reason'],
      ['T-3', 'D-9', '10', "Supporter: nothing loaded has old id 'D-9'"],
    ]);
  });

  it('updates by old id on a second run instead of adding records again', async () => {
    let view = await ok(await call(migrator, 'GET', `/api/migrations/${id}`));
    view = await ok(await call(migrator, 'DELETE', `/api/migrations/${id}/sources/${source(view, 'supporters.csv').id}`));
    expect(view.status).toBe('draft');
    const fixed = ['DonorId,Full Name,Mail,Legacy code', 'D-1,Asha R. Rao,asha@example.org,X19', 'D-2,Ravi Kumar,,X20', 'D-3,Dev,nobody@example.org,X21'].join('\r\n');
    view = await ok(await addFile(migrator, id, 'supporters.csv', fixed), 201);
    view = await ok(await call(migrator, 'PUT', `/api/migrations/${id}/sources/${source(view, 'supporters.csv').id}/mapping`, SUPPORTER_MAP));
    expect(view.sources.map((s) => s.fileName)).toEqual(['combined.csv', 'supporters.csv', 'gifts.csv']);
    view = await ok(await call(migrator, 'POST', `/api/migrations/${id}/check`));
    expect(view.check!.sources.find((s) => s.fileName === 'supporters.csv')).toMatchObject({ ready: 3, invalid: 0, creates: 1, updates: 2 });
    await ok(await call(migrator, 'POST', `/api/migrations/${id}/run`), 202);
    await w.platform.jobs.runOnce();
    view = await ok(await call(migrator, 'GET', `/api/migrations/${id}`));
    expect(view.status).toBe('done');
    expect((await all('supporter')).map((r) => r.data.name)).toEqual(['Asha R. Rao', 'Ravi Kumar', 'Meena', 'Kiran', 'Dev']);
    expect((await all('pledge')).length).toBe(3);
    expect(await count(`select next_value::int as n from sequence_counter where tenant_id = $1 and key = 'receipt:donation-receipt'`, [w.ngoA])).toBe(2045);
  });

  it('never lowers a receipt counter', async () => {
    const out = await w.platform.db.withTenant(w.ngoA, (tx) => w.platform.receipts.continueNumbering(asTx(tx), 'donation-receipt', today(), 10));
    expect(out.next).toBe(2045);
  });

  it('cancels a run before its next batch', async () => {
    const other = (await ok(await call(migrator, 'POST', '/api/migrations', { name: 'Second' }), 201)).id;
    let view = await ok(await addFile(migrator, other, 'more.csv', ['Id,Who', ...Array.from({ length: 250 }, (_, i) => `M-${i},Person ${i}`)].join('\n')), 201);
    await ok(
      await call(migrator, 'PUT', `/api/migrations/${other}/sources/${view.sources[0]!.id}/mapping`, {
        targets: [{ key: 's', type: 'supporter', oldId: 'Id', fields: { name: 'Who' } }],
      }),
    );
    await ok(await call(migrator, 'POST', `/api/migrations/${other}/check`));
    await ok(await call(migrator, 'POST', `/api/migrations/${other}/run`), 202);
    view = await ok(await call(migrator, 'POST', `/api/migrations/${other}/cancel`));
    await w.platform.jobs.runOnce();
    view = await ok(await call(migrator, 'GET', `/api/migrations/${other}`));
    expect(view.status).toBe('failed');
    expect(await count(`select count(*)::int as n from migration_key where profile_id = $1`, [other])).toBeLessThan(250);
  });

  it('needs the migration permission, the import permission of each record type, and stays in its organisation', async () => {
    const outsider: Actor = { id: 'outsider', roles: [], permissions: ['record:supporter:*'] };
    expect((await call(outsider, 'GET', '/api/migrations')).statusCode).toBe(403);
    const noPledges = await member('nopledges', ['data:migrate', 'record:supporter:*']);
    const view = await ok(await call(migrator, 'GET', `/api/migrations/${id}`));
    expect((await call(noPledges, 'PUT', `/api/migrations/${id}/sources/${source(view, 'gifts.csv').id}/mapping`, GIFT_MAP)).statusCode).toBe(403);
    const elsewhere = await app.inject({ method: 'GET', url: `/api/migrations/${id}`, headers: headers({ ...migrator, id: 'admin-b' }, w.ngoB) });
    expect(elsewhere.statusCode).toBe(404);
    const keysInB = await w.platform.db.withTenant(w.ngoB, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from migration_key`));
    expect(Number(keysInB[0]!.n)).toBe(0);
  });
});
