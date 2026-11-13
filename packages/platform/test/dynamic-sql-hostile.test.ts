import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordAggregates, type AggregateRequest } from '../src/runtime/records/aggregates.js';
import { compileAggregate, compileRecordQuery, compileSums } from '../src/infrastructure/postgres/query-compiler/record-query.js';
import { recordAggregate, recordCount, recordIds } from '../src/infrastructure/postgres/stores/record-queries.js';
import type { Actor, SqlExecutor } from '../src/infrastructure/postgres/db.js';
import { transactions } from '../src/infrastructure/postgres/tx.js';
import type { RecordAggregateAst, RecordGroup, RecordPredicate, RecordQueryAst, RecordSort } from '../src/runtime/records/query-ast.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
const finance: Actor = { id: 'fin-1', roles: ['finance'], permissions: ['record:donor:*', 'record:donation:*'] };
const ctx = () => w.as(w.ngoA, finance);

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await w.platform.records.create(ctx(), 'donation', { donorName: 'Asha', amount: 100 });
});
afterAll(() => w.close());

/** Text that would change a clause if it were written into it. */
const INJECTIONS = [
  "x'); drop table record; --",
  "amount' or '1'='1",
  'amount)::numeric or (true',
  'amount" or "1"="1',
  'a b',
  'Amount',
];
/** Keys of every plain object: valid key text, but not fields. */
const PROTOTYPE_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];

const page = (where: RecordPredicate[], sort: RecordSort = { kind: 'newest' }): RecordQueryAst => ({ where, sort, limit: 10, offset: 0 });
const ofDonation: RecordPredicate = { kind: 'ofType', type: 'donation' };

describe('the record-query compiler', () => {
  it('refuses field, type and workflow keys that are not definition keys', () => {
    for (const bad of INJECTIONS) {
      const shapes: RecordPredicate[] = [
        { kind: 'ofType', type: bad },
        { kind: 'equals', field: bad, value: 1 },
        { kind: 'oneOf', field: bad, as: 'text', values: ['a'] },
        { kind: 'range', field: bad, as: 'numeric', from: 1 },
        { kind: 'near', field: bad, lat: 1, lng: 1, km: 1 },
        { kind: 'matches', field: bad, as: 'caseless', value: 'a' },
        { kind: 'workflowIn', workflow: bad, primary: false, orNone: false, states: ['a'] },
      ];
      for (const p of shapes) expect(() => compileRecordQuery(page([p])), `${p.kind} ${bad}`).toThrow(TypeError);
      expect(() => compileRecordQuery(page([ofDonation], { kind: 'field', field: bad, as: 'text', dir: 'asc' }))).toThrow(TypeError);
      expect(() => compileAggregate({ where: 'true', args: [] }, { measure: { kind: 'sum', field: bad } })).toThrow(TypeError);
      expect(() => compileAggregate({ where: 'true', args: [] }, { measure: { kind: 'count' }, group: { kind: 'field', field: bad } })).toThrow(TypeError);
      expect(() => compileSums([bad])).toThrow(TypeError);
    }
  });

  it('refuses nodes, columns, periods and start months outside the AST', () => {
    const count = { kind: 'count' } as const;
    const where = { where: 'true', args: [] };
    expect(() => compileRecordQuery(page([{ kind: 'raw', sql: 'true' } as unknown as RecordPredicate]))).toThrow(TypeError);
    expect(() => compileRecordQuery(page([ofDonation], { kind: 'column', column: 'tenant_id', dir: 'asc' } as unknown as RecordSort))).toThrow(TypeError);
    expect(() => compileRecordQuery(page([ofDonation], { kind: 'column', column: 'constructor', dir: 'asc' } as unknown as RecordSort))).toThrow(TypeError);
    expect(() => compileAggregate(where, { measure: { kind: 'max', field: 'amount' } } as unknown as RecordAggregateAst)).toThrow(TypeError);
    for (const group of [
      { kind: 'period', period: 'constructor', date: { column: 'createdAt' } },
      { kind: 'period', period: 'day', date: { column: 'constructor' } },
      { kind: 'period', period: 'financialYear', date: { column: 'createdAt' } },
      { kind: 'period', period: 'financialYear', date: { column: 'createdAt' }, fiscalYearStartMonth: 13 },
      { kind: 'period', period: 'financialYear', date: { column: 'createdAt' }, fiscalYearStartMonth: 1.5 },
    ]) {
      expect(() => compileAggregate(where, { measure: count, group: group as RecordGroup }), JSON.stringify(group)).toThrow(TypeError);
    }
    expect(() => compileRecordQuery(page([{ kind: 'near', field: 'place', lat: Number.NaN, lng: 1, km: 1 }]))).toThrow(TypeError);
  });
});

describe('list queries from a request', () => {
  it('refuse injected or prototype field names in filters, equals, sorts and workflows', async () => {
    for (const bad of [...INJECTIONS, ...PROTOTYPE_KEYS]) {
      await expectCode(w.platform.records.query(ctx(), 'donation', { filters: { [bad]: { eq: 'x' } } }), 'validation_failed');
      await expectCode(w.platform.records.query(ctx(), 'donation', { equals: { [bad]: 'x' } }), 'validation_failed');
      await expectCode(w.platform.records.query(ctx(), 'donation', { sort: { field: bad } }), 'validation_failed');
      await expectCode(w.platform.records.query(ctx(), 'donation', { states: { [bad]: ['x'] } }), 'validation_failed');
    }
  });

  it('bind injected values, never writing them into the clauses', async () => {
    for (const bad of INJECTIONS) {
      const c = {
        ids: [bad],
        statusIn: [bad],
        search: bad,
        equals: { donorName: bad },
        filters: { method: { in: [bad], eq: bad }, donorName: { in: [bad] } },
      };
      const q = compileRecordQuery((await w.platform.records.buildQuery(ctx(), 'donation', c)).ast);
      expect(q.where).not.toContain(bad);
      expect(q.order).not.toContain(bad);
      expect(JSON.stringify(q.args)).toContain(JSON.stringify(bad).slice(1, -1));
      const { items, total } = await w.platform.records.query(ctx(), 'donation', { ...c, ids: undefined, sum: ['amount'] });
      expect({ items, total }).toEqual({ items: [], total: 0 });
    }
  });

  it('refuse injected values where a number, a date, a point or a single value is needed', async () => {
    for (const bad of INJECTIONS) {
      await expectCode(w.platform.records.query(ctx(), 'donation', { filters: { amount: { from: bad } } }), 'validation_failed');
      await expectCode(w.platform.records.query(ctx(), 'donation', { filters: { paidOn: { to: bad } } }), 'validation_failed');
      await expectCode(w.platform.records.query(ctx(), 'donation', { filters: { donorName: { from: bad } } }), 'validation_failed');
    }
    await expectCode(w.platform.records.query(ctx(), 'donation', { equals: { donorName: { or: 1 } as unknown as string } }), 'validation_failed');
    await expectCode(w.platform.records.query(ctx(), 'donation', { filters: { method: { eq: ['a'] as unknown as string } } }), 'validation_failed');
  });

  it('refuse injected aggregate fields, groups, periods and measures', async () => {
    const agg = new RecordAggregates(transactions(w.platform.db), w.platform.records);
    for (const bad of [...INJECTIONS, ...PROTOTYPE_KEYS]) {
      const requests: AggregateRequest[] = [
        { measure: 'sum', field: bad },
        { measure: 'count', groupBy: { field: bad } },
        { measure: 'count', groupBy: { period: 'day', dateField: bad } },
        { measure: 'count', groupBy: { period: bad as 'day', dateField: 'createdAt' } },
        { measure: bad as 'count' },
      ];
      for (const req of requests) await expectCode(agg.aggregate(ctx(), 'donation', req), 'validation_failed');
    }
  });
});

describe('the record query functions', () => {
  const ok = (clause: string, part: string) =>
    w.platform.db.asSystem(async (tx) => (await tx.query<{ ok: boolean }>(`select app_record_clause_ok($1, $2) as ok`, [clause, part]))[0]!.ok);
  const inA = <T>(fn: (tx: SqlExecutor) => Promise<T>) => w.platform.db.withTenant(w.ngoA, fn);

  const everyPredicate: RecordPredicate[] = [
    ofDonation,
    { kind: 'visibleTo', person: 'u-1', roles: ['finance'], approvableSteps: ['approve'] },
    { kind: 'visibleTo', person: 'u-1', roles: [], approvableSteps: [] },
    { kind: 'sharedWith', person: 'u-1', roles: ['finance'] },
    { kind: 'ownedBy', person: 'u-1' },
    { kind: 'idIn', ids: ['a'] },
    { kind: 'idIs', id: randomUUID() },
    { kind: 'idIsNot', id: randomUUID() },
    { kind: 'numberIs', number: 'D-1' },
    { kind: 'statusIn', values: ['paid'] },
    { kind: 'workflowIn', workflow: 'donation', primary: true, orNone: true, states: ['paid'] },
    { kind: 'workflowIn', workflow: 'donation', primary: true, orNone: false, states: ['paid'] },
    { kind: 'workflowIn', workflow: 'review', primary: false, orNone: false, states: ['open'] },
    { kind: 'search', text: "50%_off \\ o'brien" },
    { kind: 'containsAny', fields: ['donorName', 'note'], text: "50%_off \\ o'brien" },
    { kind: 'equals', field: 'method', value: 'cash' },
    { kind: 'oneOf', field: 'method', as: 'text', values: ['cash'] },
    { kind: 'oneOf', field: 'amount', as: 'numeric', values: [1, 2] },
    { kind: 'oneOf', field: 'tags', as: 'multi', values: ['a'] },
    { kind: 'range', field: 'amount', as: 'numeric', from: 1, to: 2 },
    { kind: 'range', field: 'paidOn', as: 'date', from: '2026-01-01' },
    { kind: 'near', field: 'place', lat: 19, lng: 72, km: 10 },
    { kind: 'matches', field: 'pan', as: 'caseless', value: 'ABC' },
    { kind: 'matches', field: 'amount', as: 'numeric', value: '12.5' },
  ];
  const everySort: RecordSort[] = [
    { kind: 'newest' },
    { kind: 'id' },
    { kind: 'column', column: 'number', dir: 'asc' },
    { kind: 'column', column: 'updatedAt', dir: 'desc' },
    { kind: 'field', field: 'amount', as: 'numeric', dir: 'asc' },
    { kind: 'field', field: 'donorName', as: 'text', dir: 'desc' },
    { kind: 'distance', field: 'place', lat: 19, lng: 72, dir: 'asc' },
  ];
  const everyGroup: (RecordGroup | undefined)[] = [
    undefined,
    { kind: 'status' },
    { kind: 'field', field: 'method' },
    { kind: 'period', period: 'day', date: { column: 'createdAt' } },
    { kind: 'period', period: 'week', date: { column: 'updatedAt' } },
    { kind: 'period', period: 'month', date: { field: 'paidOn' } },
    { kind: 'period', period: 'financialYear', date: { column: 'createdAt' }, fiscalYearStartMonth: 4 },
    { kind: 'period', period: 'financialYear', date: { field: 'paidOn' }, fiscalYearStartMonth: 1 },
  ];

  it('accept and run every clause shape the compiler writes', async () => {
    const all = compileRecordQuery(page(everyPredicate));
    expect(await ok(all.where, 'where')).toBe(true);
    await inA(async (tx) => {
      expect(await recordIds(tx, all)).toEqual([]);
      expect(await recordCount(tx, all)).toBe(0);
    });
    for (const sort of everySort) {
      const q = compileRecordQuery(page([ofDonation], sort));
      expect(await ok(q.order, 'order'), sort.kind).toBe(true);
      await inA((tx) => recordIds(tx, q));
    }
    const base = compileRecordQuery(page([ofDonation]));
    for (const group of everyGroup) {
      for (const measure of [{ kind: 'count' }, { kind: 'sum', field: 'amount' }] as const) {
        const c = compileAggregate(base, { measure, group });
        expect(await ok(c.select, 'select'), JSON.stringify(group)).toBe(true);
        expect(await ok(c.where, 'where'), JSON.stringify(group)).toBe(true);
        await inA((tx) => recordAggregate(tx, base, { measure, group }));
      }
    }
    expect(await ok(compileSums(['amount', 'netAmount']), 'select')).toBe(true);
  });

  it('refuse conditions outside the compiled grammar', async () => {
    const share =
      "exists (select 1 from record_share s where s.tenant_id = app_tenant() and s.record_id = r.id and (s.expires_at is null or s.expires_at > now()) and ((s.principal_kind = 'user' and s.principal = ($1->>0)) or (s.principal_kind = 'role' and s.principal = any(array(select jsonb_array_elements_text($1->1))))))";
    const hostile = [
      'true; drop table record',
      'true -- x',
      'true /* x */',
      'true) or (true',
      '(true',
      'exists (select 1 from record x where x.tenant_id <> app_tenant())',
      'id in (select id from record)',
      'true union select id from record',
      'pg_sleep(1) is null',
      "current_setting('app.tenant_id') is not null",
      "set_config('app.tenant_id', 'x', true) is not null",
      "lower(data->>'k') = 'ABC'",
      "data->>'k' = 'a b'",
      "status = 'x'' or ''1''=''1'",
      "data->>'k' = E'\\x41'",
      "data->>'k' = U&'\\0041'",
      "data->>'k' = $$x$$",
      '"record".id is not null',
      'id::text = ($1->>0) or $2 is null',
      'id::text = $10',
      'TRUE',
      'r.tableoid > 0',
      'now() is not null',
      "data #> '{a}' is null",
      "data @> 'a'",
      "status ~ 'x'",
      'status !~~ status',
      "type_key = 'donation' and status = any(array(select jsonb_array_elements_text($1->0) union select type_key from record))",
      "exists (select 1 from record_share s where s.tenant_id = app_tenant())",
      share.replace('s.tenant_id = app_tenant()', 's.tenant_id <> app_tenant()'),
      `${share} or exists (select 1 from record_share s where true)`,
      'r.created_by is distinct from (select 1)',
    ];
    for (const bad of hostile) {
      expect(await ok(bad, 'where'), bad).toBe(false);
      await expect(inA((tx) => tx.query(`select id from app_record_ids($1, 'id', '[]', 1, 0)`, [bad])), bad).rejects.toThrow(/invalid record query/);
      await expect(inA((tx) => tx.query(`select app_record_count($1, '[]')`, [bad])), bad).rejects.toThrow(/invalid record query/);
      await expect(inA((tx) => tx.query(`select app_record_agg('count(*) as v', $1, null, '[]')`, [bad])), bad).rejects.toThrow(/invalid record query/);
    }
    expect(await ok(share, 'where')).toBe(true);
  });

  it('refuse orders, selects, groups and arguments outside the compiled grammar', async () => {
    const orders = ['id; drop table record', '(select 1)', 'id, (select count(*) from record)', 'pg_sleep(1)', 'array(select jsonb_array_elements_text($1->0))', 'id desc --'];
    for (const bad of orders) {
      await expect(inA((tx) => tx.query(`select id from app_record_ids('true', $1, '[]', 1, 0)`, [bad])), bad).rejects.toThrow(/invalid record query/);
    }
    const selects = ['(select count(*) from record) as v', 'count(*) as v from record r2 where true or', 'pg_sleep(1) as v', "to_char(now(), 'HH24') as v", 'array(select jsonb_array_elements_text($1->0)) as v'];
    for (const bad of selects) {
      await expect(inA((tx) => tx.query(`select app_record_agg($1, 'true', null, '[]')`, [bad])), bad).rejects.toThrow(/invalid record query/);
    }
    for (const bad of ['1; drop table record', 'status', '1, (select 1)', '0', '10']) {
      await expect(inA((tx) => tx.query(`select app_record_agg('count(*) as v', 'true', $1, '[]')`, [bad])), bad).rejects.toThrow(/invalid record query/);
    }
    for (const args of ['{}', '"x"', 'null']) {
      await expect(inA((tx) => tx.query(`select id from app_record_ids('true', 'id', $1, 1, 0)`, [args])), args).rejects.toThrow(/invalid record query/);
    }
  });

  it('may be run only by the runtime role, as their owner, with a pinned search path', async () => {
    const rows = await w.platform.db.asSystem((tx) =>
      tx.query<{ name: string; definer: boolean; owner: string; config: string[] | null; runners: string[] }>(
        `select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner)::text as owner, p.proconfig as config,
                array(select case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee)::text end
                        from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE' order by 1) as runners
           from pg_proc p where p.pronamespace = current_schema()::regnamespace and p.proname like 'app\\_record\\_%' order by 1`,
      ),
    );
    expect(rows.map((r) => r.name)).toEqual(['app_record_agg', 'app_record_clause_ok', 'app_record_count', 'app_record_ids']);
    for (const r of rows) {
      const runtime = r.name !== 'app_record_clause_ok';
      expect(r.runners, r.name).toEqual((runtime ? [r.owner, 'app_runtime'] : [r.owner]).sort());
      expect(r.definer, r.name).toBe(runtime);
      if (runtime) expect(r.config?.find((s) => s.startsWith('search_path='))).toMatch(/, pg_temp$/);
    }
    const signatures = ['app_record_ids(text, text, jsonb, integer, integer)', 'app_record_count(text, jsonb)', 'app_record_agg(text, text, text, jsonb)', 'app_record_clause_ok(text, text)'];
    const [privileges] = await w.platform.db.asSystem((tx) =>
      tx.query<{ others: boolean[] }>(
        `select array(select has_function_privilege(r, f, 'execute') from unnest($1::text[]) f, unnest(array['public', 'pg_monitor']) r) as others`,
        [signatures],
      ),
    );
    expect(privileges!.others.every((x) => x === false)).toBe(true);
    await expect(inA((tx) => tx.query(`select app_record_clause_ok('true', 'where')`))).rejects.toThrow(/permission denied/);
  });
});
