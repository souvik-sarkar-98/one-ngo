import { sql } from 'kysely';
import type { SqlExecutor } from '../db.js';
import { typed } from '../kysely.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { RecordAggregateAst, RecordQueries, RecordQueryAst } from '../../../runtime/records/ports/record-query.js';
import type { RecordRow } from '../../../runtime/records/ports/record-store.js';
import { compileAggregate, compileRecordQuery, compileSums, compileWhere, type CompiledRecordQuery } from '../query-compiler/record-query.js';
import { executorOf } from '../tx.js';
import { RECORD_COLUMNS } from './record-store.js';

const TENANT = sql<string>`app_tenant()`;
const anyUuid = (ids: string[]) => sql<string>`any(${ids}::uuid[])`;

/** Ids of the records `q` matches, in its order, through app_record_ids so the managed indexes apply. */
export async function recordIds(tx: SqlExecutor, q: CompiledRecordQuery): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(`select id from app_record_ids($1, $2, $3, $4, $5)`, [q.where, q.order, JSON.stringify(q.args), q.limit, q.offset]);
  return rows.map((r) => r.id);
}

/** How many records `q` matches, through app_record_count. */
export async function recordCount(tx: SqlExecutor, q: Pick<CompiledRecordQuery, 'where' | 'args'>): Promise<number> {
  const [row] = await tx.query<{ n: number }>(`select app_record_count($1, $2) as n`, [q.where, JSON.stringify(q.args)]);
  return row!.n;
}

/** The rows app_record_agg returns for compiled `select` over the records `where` matches, grouped by `group` when given. */
export async function recordAgg<T>(tx: SqlExecutor, select: string, where: string, group: string | null, args: unknown[]): Promise<T[]> {
  const rows = await tx.query<{ app_record_agg: T }>(`select app_record_agg($1, $2, $3, $4)`, [select, where, group, JSON.stringify(args)]);
  return rows.map((r) => r.app_record_agg);
}

/** The value `v` of `agg` over the records `q` matches, with each group's key `k` when it is grouped. */
export async function recordAggregate<T>(tx: SqlExecutor, q: Pick<CompiledRecordQuery, 'where' | 'args'>, agg: RecordAggregateAst): Promise<T[]> {
  const c = compileAggregate(q, agg);
  return recordAgg<T>(tx, c.select, c.where, c.group, c.args);
}

/** Totals of number or money fields over every record `q` matches, by field key. */
export async function recordSums(tx: SqlExecutor, q: Pick<CompiledRecordQuery, 'where' | 'args'>, keys: string[]): Promise<Record<string, number>> {
  const [agg] = await recordAgg<Record<string, string | number>>(tx, compileSums(keys), q.where, null, q.args);
  return Object.fromEntries(keys.map((k, i) => [k, Number(agg?.[`s${i}`] ?? 0)]));
}

/** Record queries through the dynamic record functions of migration 016. */
export class PgRecordQueries implements RecordQueries {
  ids(tx: Tx, q: RecordQueryAst): Promise<string[]> {
    return recordIds(executorOf(tx), compileRecordQuery(q));
  }

  /** Finds the page's ids with app_record_ids (so the managed indexes apply), then reads the rows under row-level security. */
  async rows(tx: Tx, q: RecordQueryAst): Promise<RecordRow[]> {
    const ids = await this.ids(tx, q);
    if (!ids.length) return [];
    const rows = await typed(executorOf(tx)).selectFrom('record').select(RECORD_COLUMNS).where('tenant_id', '=', TENANT).where('id', '=', anyUuid(ids)).$castTo<RecordRow>().execute();
    const at = new Map(ids.map((id, i) => [id, i]));
    return rows.sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  }

  count(tx: Tx, q: Pick<RecordQueryAst, 'where'>): Promise<number> {
    return recordCount(executorOf(tx), compileWhere(q));
  }

  aggregate<T>(tx: Tx, q: Pick<RecordQueryAst, 'where'>, agg: RecordAggregateAst): Promise<T[]> {
    return recordAggregate<T>(executorOf(tx), compileWhere(q), agg);
  }

  sums(tx: Tx, q: Pick<RecordQueryAst, 'where'>, keys: string[]): Promise<Record<string, number>> {
    return recordSums(executorOf(tx), compileWhere(q), keys);
  }
}
