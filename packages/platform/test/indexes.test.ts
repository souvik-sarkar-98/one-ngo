import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileRecordQuery } from '../src/infrastructure/postgres/query-compiler/record-query.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { MAX_INDEXES_PER_TYPE } from '../src/runtime/definitions/index-manager.js';
import type { DefinitionBodies, DefinitionKind, FieldDef } from '../src/runtime/definitions/types.js';
import { createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
const finance: Actor = { id: 'fin-1', roles: ['finance'], permissions: ['record:donor:*', 'record:donation:*'] };

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
});
afterAll(() => w.close());

async function publish<K extends DefinitionKind>(tenant: string, kind: K, body: DefinitionBodies[K]): Promise<void> {
  await w.platform.definitions.saveDraft(w.as(tenant), kind, body);
  await w.platform.definitions.publish(w.as(tenant), kind, body.key);
}
const managed = () =>
  w.platform.db.asSystem((tx) => tx.query<{ name: string; type_key: string; field: string; cast_as: string; kind: string; status: string }>(
    `select name, type_key, field, cast_as, kind, status from managed_index order by type_key, field, cast_as, kind`,
  ));
const existing = async () =>
  new Set((await w.platform.db.asSystem((tx) => tx.query<{ indexname: string }>(`select indexname from pg_indexes where indexname like 'rx_%' and schemaname = current_schema()`))).map((r) => r.indexname));

describe('managed indexes', () => {
  it('plan references, unique fields, filters and sorts for the Donations module', async () => {
    const { needed, overCap } = await w.platform.indexes.plan(w.ngoA);
    const keys = needed.map((n) => `${n.typeKey}.${n.field}:${n.cast}:${n.kind}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'donor.pan:hash:unique',
        'donation.donor:text:reference',
        'donation.method:text:filter',
        'donation.paidOn:text:filter',
        'donation.amount:numeric:filter',
        'donor.city:text:filter',
        'donor.name:text:sort',
      ]),
    );
    expect(keys).not.toContain('donation.donorPan:text:filter');
    expect(overCap).toEqual([]);
  });

  it('are built once and shared by organisations with the same record type', async () => {
    const first = await w.platform.indexes.buildPending(w.ngoA, 100);
    expect(first.failed).toEqual([]);
    const rows = await managed();
    expect(rows.every((r) => r.status === 'ready')).toBe(true);
    const names = await existing();
    for (const r of rows) expect(names.has(r.name)).toBe(true);
    const again = await w.platform.indexes.buildPending(w.ngoB, 100);
    expect(again.built).toEqual([]);
    expect(await managed()).toHaveLength(rows.length);
  });

  it('keep separate indexes for the same field compared differently', async () => {
    await publish(w.ngoA, 'recordType', { key: 'gadget', label: 'Gadget', fields: [{ key: 'size', label: 'Size', type: 'number' }] });
    await publish(w.ngoA, 'listView', { key: 'gadgets', recordType: 'gadget', filters: ['size'] });
    await publish(w.ngoB, 'recordType', { key: 'gadget', label: 'Gadget', fields: [{ key: 'size', label: 'Size', type: 'text' }] });
    await publish(w.ngoB, 'listView', { key: 'gadgets', recordType: 'gadget', filters: ['size'] });
    await w.platform.indexes.buildPending(w.ngoA, 100);
    await w.platform.indexes.buildPending(w.ngoB, 100);
    const sizes = (await managed()).filter((r) => r.type_key === 'gadget' && r.field === 'size');
    expect(sizes.map((r) => r.cast_as).sort()).toEqual(['numeric', 'text']);
    expect(new Set(sizes.map((r) => r.name)).size).toBe(2);
  });

  it('are capped per record type, with a warning for the Builder', async () => {
    const fields: FieldDef[] = Array.from({ length: 30 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: 'number' }));
    await publish(w.ngoA, 'recordType', { key: 'wide', label: 'Wide', fields });
    await publish(w.ngoA, 'listView', { key: 'wides', recordType: 'wide', filters: fields.map((f) => f.key) });
    const plan = await w.platform.indexes.plan(w.ngoA);
    expect(plan.needed.filter((n) => n.typeKey === 'wide')).toHaveLength(MAX_INDEXES_PER_TYPE);
    expect(plan.overCap.map((o) => o.field)).toEqual(['f25', 'f26', 'f27', 'f28', 'f29']);
    const warn = await w.platform.indexes.warnings(w.ngoA, 'wide');
    expect(warn.notIndexed).toEqual(['f25', 'f26', 'f27', 'f28', 'f29']);
    expect(warn.pending).toHaveLength(MAX_INDEXES_PER_TYPE);
    const builder = w.platform.builderSupport();
    expect(await builder.indexWarnings(w.as(w.ngoA), 'wide')).toEqual(warn);
    await expect(builder.indexWarnings(w.as(w.ngoA, finance), 'wide')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(builder.indexWarnings(w.as(w.ngoA), "x'; drop")).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('are dropped when nothing has needed them for 30 days', async () => {
    await w.platform.db.exec(`create index rx_unused on record (tenant_id, (data->>'gone')) where type_key = 'gadget' and deleted_at is null`);
    await w.platform.db.asSystem(async (tx) => {
      await tx.query(
        `insert into managed_index (name, type_key, field, cast_as, kind, status, last_needed_at) values ('rx_unused', 'gadget', 'gone', 'text', 'filter', 'ready', now() - interval '31 days')`,
      );
      await tx.query(`update managed_index set last_needed_at = now() - interval '40 days' where type_key = 'donation'`);
    });
    const { dropped } = await w.platform.indexes.maintain();
    expect(dropped).toEqual(['rx_unused']);
    const names = await existing();
    expect(names.has('rx_unused')).toBe(false);
    expect((await managed()).filter((r) => r.type_key === 'donation').length).toBeGreaterThan(0);
  });

  it('are built in the background after a list view is published', async () => {
    await publish(w.ngoA, 'listView', { key: 'gadgets', recordType: 'gadget', filters: ['size'], columns: ['size'] });
    await w.platform.dispatcher.runOnce();
    const [job] = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ status: string }>(`select status from job where kind = 'index.build'`));
    expect(job?.status).toBe('queued');
    await w.platform.jobs.runOnce();
    const [after] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ n: number }>(`select count(*)::int as n from job where kind = 'index.build' and status <> 'done'`),
    );
    expect(after!.n).toBe(0);
  });
});

describe('query plans', () => {
  beforeAll(async () => {
    const ctx = w.as(w.ngoA, finance);
    for (let i = 0; i < 40; i++) {
      await w.platform.records.create(ctx, 'donation', { donorName: `Donor ${i}`, amount: 100 + i });
    }
    await w.platform.db.asSystem((tx) =>
      tx.query(
        `insert into record (tenant_id, type_key, schema_version, data, search_text)
         select $1, 'donation', 1, jsonb_build_object('donorName', 'Bulk ' || g, 'amount', g % 97), 'bulk ' || md5(g::text)
           from generate_series(1, 20000) g`,
        [w.ngoA],
      ),
    );
    await w.platform.indexes.buildPending(w.ngoA, 100);
    await w.platform.db.exec('analyze record');
  });

  /** Plans the statement app_record_ids runs: as the owner, for the organisation set in the session. */
  const explain = (sql: string, args: unknown[], limit = 20, offset = 0, settings: string[] = []) =>
    w.platform.db.asSystem(async (tx) => {
      await tx.query(`select set_config('app.tenant_id', $1, true), set_config('app.tenant_seal', app_tenant_seal($1::uuid), true)`, [w.ngoA]);
      for (const s of ['enable_seqscan', ...settings]) await tx.query(`set local ${s} = off`);
      // The query functions run with this setting (migration 009).
      await tx.query('set local random_page_cost = 1.1');
      // app_record_ids runs EXECUTE ... USING, which plans with the argument values known; write them in the same way.
      const literal = `'${JSON.stringify(args).replace(/'/g, "''")}'::jsonb`;
      const text = sql.replace('limit $2 offset $3', `limit ${limit} offset ${offset}`).replace(/\$1(?!\d)/g, literal);
      const rows = await tx.query<{ 'QUERY PLAN': string }>(`explain ${text}`);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
  const plan = async (c: Parameters<TestWorld['platform']['records']['buildQuery']>[2], settings: string[] = []) => {
    const q = compileRecordQuery((await w.platform.records.buildQuery(w.as(w.ngoA, finance), 'donation', c)).ast);
    return explain(q.idsSql, q.args, q.limit, q.offset, settings);
  };
  /** The count has no order to satisfy, so it shows whether the filter itself can use an index. */
  const countPlan = async (c: Parameters<TestWorld['platform']['records']['buildQuery']>[2]) => {
    const q = compileRecordQuery((await w.platform.records.buildQuery(w.as(w.ngoA, finance), 'donation', c)).ast);
    return explain(q.countSql, q.args);
  };
  const nameOf = async (typeKey: string, field: string, cast: string) =>
    (await managed()).find((r) => r.type_key === typeKey && r.field === field && r.cast_as === cast)!.name;

  it('use the managed index for filters', async () => {
    expect(await countPlan({ filters: { amount: { from: 120, to: 130 } } })).toContain(await nameOf('donation', 'amount', 'numeric'));
    expect(await countPlan({ filters: { method: { in: ['cash'] } } })).toContain(await nameOf('donation', 'method', 'text'));
  });

  it('use the managed index for sorting', async () => {
    expect(await plan({ sort: { field: 'amount', dir: 'asc' } }, ['enable_sort'])).toContain(await nameOf('donation', 'amount', 'numeric'));
  });

  it('use the trigram index for search', async () => {
    const p = await countPlan({ search: 'donor 1' });
    expect(p).toContain('record_search');
    const { items } = await w.platform.records.query(w.as(w.ngoA, finance), 'donation', { search: 'DONOR 3', limit: 50 });
    expect(items.map((r) => r.data.donorName).sort()).toEqual(['Donor 3', 'Donor 30', 'Donor 31', 'Donor 32', 'Donor 33', 'Donor 34', 'Donor 35', 'Donor 36', 'Donor 37', 'Donor 38', 'Donor 39']);
  });

  it('use the unique index on the keyed hash for the duplicate check of a sensitive field', async () => {
    const name = await nameOf('donor', 'pan', 'hash');
    const p = await explain(
      `select id from record where tenant_id = app_tenant() and type_key = 'donor' and deleted_at is null and (blind_index->>'pan') = any(array['${'0'.repeat(64)}']::text[]) order by id limit $2 offset $3`,
      [],
      1,
    );
    expect(p).toContain(name);
  });

  it('keep reading rows under row-level security, and refuse unsafe clauses', async () => {
    const q = compileRecordQuery((await w.platform.records.buildQuery(w.as(w.ngoA, finance), 'donation', {})).ast);
    const other = await w.platform.db.withTenant(w.ngoB, (tx) =>
      tx.query<{ id: string }>(`select id from app_record_ids($1, $2, $3, 100, 0)`, [q.where, q.order, JSON.stringify(q.args)]),
    );
    const mine = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ id: string }>(`select id from app_record_ids($1, $2, $3, 100, 0)`, [q.where, q.order, JSON.stringify(q.args)]),
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(other.some((r) => mine.some((m) => m.id === r.id))).toBe(false);
    for (const bad of ['true; drop table record', 'true -- x', 'true) or (true']) {
      await expect(
        w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`select id from app_record_ids($1, 'id', '[]', 1, 0)`, [bad])),
      ).rejects.toThrow(/invalid record query/);
    }
  });
});
