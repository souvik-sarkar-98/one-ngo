import { describe, expect, it } from 'vitest';
import { compileRecordQuery } from '../src/infrastructure/postgres/query-compiler/record-query.js';
import { recordAgg, recordCount, recordIds, recordSums } from '../src/infrastructure/postgres/stores/record-queries.js';
import type { SqlExecutor } from '../src/infrastructure/postgres/db.js';
import type { FieldDef } from '../src/runtime/definitions/types.js';
import type { RecordQueryAst } from '../src/runtime/records/query-ast.js';
import { onlyIds, uniqueValueQuery } from '../src/runtime/records/query.js';

/** An executor that records each statement and answers with `rows`. */
function fake(rows: unknown[]) {
  const sent: { sql: string; params: unknown[] }[] = [];
  const tx: SqlExecutor = {
    query: async <T>(sql: string, params?: unknown[]) => {
      sent.push({ sql, params: params ?? [] });
      return rows as T[];
    },
    queryWithRowCount: () => Promise.reject(new Error('not used')),
  };
  return { tx, sent };
}

const q = { where: `type_key = 'donation' and status = any(array(select jsonb_array_elements_text($1->0)))`, order: 'created_at desc, id desc', args: [['paid']], limit: 20, offset: 40 };

describe('record query functions', () => {
  it('sends a list query to app_record_ids with its values as one jsonb array', async () => {
    const { tx, sent } = fake([{ id: 'a' }, { id: 'b' }]);
    expect(await recordIds(tx, q)).toEqual(['a', 'b']);
    expect(sent).toEqual([{ sql: 'select id from app_record_ids($1, $2, $3, $4, $5)', params: [q.where, q.order, '[["paid"]]', 20, 40] }]);
  });

  it('counts through app_record_count', async () => {
    const { tx, sent } = fake([{ n: 7 }]);
    expect(await recordCount(tx, q)).toBe(7);
    expect(sent).toEqual([{ sql: 'select app_record_count($1, $2) as n', params: [q.where, '[["paid"]]'] }]);
  });

  it('unwraps the rows of app_record_agg, with no group when none is given', async () => {
    const { tx, sent } = fake([{ app_record_agg: { k: 'x', v: 2 } }]);
    expect(await recordAgg(tx, 'r.status as k, count(*) as v', q.where, '1', q.args)).toEqual([{ k: 'x', v: 2 }]);
    expect(sent[0]).toEqual({ sql: 'select app_record_agg($1, $2, $3, $4)', params: ['r.status as k, count(*) as v', q.where, '1', '[["paid"]]'] });

    const sums = fake([{ app_record_agg: { s0: '12.50', s1: null } }]);
    expect(await recordSums(sums.tx, q, ['amount', 'fee'])).toEqual({ amount: 12.5, fee: 0 });
    expect(sums.sent[0]!.params[0]).toMatch(/^coalesce\(sum\(.+\), 0\) as s0, coalesce\(sum\(.+\), 0\) as s1$/);
    expect(sums.sent[0]!.params[2]).toBeNull();
  });

  it('narrows a query to some ids on one page, binding them after its own values', () => {
    const ast: RecordQueryAst = { where: [{ kind: 'ofType', type: 'donation' }, { kind: 'statusIn', values: ['paid'] }], sort: { kind: 'newest' }, limit: 20, offset: 40 };
    const narrowed = onlyIds(ast, ['a', 'b']);
    expect(narrowed).toEqual({ ...ast, where: [...ast.where, { kind: 'idIn', ids: ['a', 'b'] }], limit: 2, offset: 0 });
    expect(compileRecordQuery(narrowed)).toMatchObject({
      where: `type_key = 'donation' and deleted_at is null and status = any(array(select jsonb_array_elements_text($1->0))) and id::text = any(array(select jsonb_array_elements_text($1->1)))`,
      args: [['paid'], ['a', 'b']],
      limit: 2,
      offset: 0,
    });
  });

  it('looks a unique value up by one id, leaving out the record being saved', () => {
    const email = { key: 'email', type: 'text', unique: true } as FieldDef;
    expect(compileRecordQuery(uniqueValueQuery('donor', email, 'a@x.org', null))).toMatchObject({ order: 'id', args: ['a@x.org'], limit: 1, offset: 0 });
    const other = compileRecordQuery(uniqueValueQuery('donor', email, 'a@x.org', 'rec-1'));
    expect(other.args).toEqual(['a@x.org', 'rec-1']);
    expect(other.where).toMatch(/ and id <> \(\$1->>1\)::uuid$/);
  });
});
