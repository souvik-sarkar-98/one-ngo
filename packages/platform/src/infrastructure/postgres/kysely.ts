import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { DB } from './db-types.js';
import type { SqlExecutor } from './db.js';

export { sql } from 'kysely';
export type { DB } from './db-types.js';
export type TypedDb = Kysely<DB>;

const NO_TRANSACTIONS =
  'Kysely cannot open transactions or savepoints here: open them with Database.withTenant() or asSystem(), or share one with joinTransaction(), and call typed(tx) inside.';

class ExecutorConnection implements DatabaseConnection {
  constructor(private readonly tx: SqlExecutor) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const { rows, affectedRows } = await this.tx.queryWithRowCount<R>(compiled.sql, [...compiled.parameters]);
    return { rows, numAffectedRows: affectedRows === undefined ? undefined : BigInt(affectedRows) };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming is not available through a transaction executor.');
  }
}

class ExecutorDriver implements Driver {
  private readonly connection: ExecutorConnection;

  constructor(tx: SqlExecutor) {
    this.connection = new ExecutorConnection(tx);
  }

  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}

  beginTransaction(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS));
  }
  commitTransaction(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS));
  }
  rollbackTransaction(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS));
  }
  savepoint(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS));
  }
  rollbackToSavepoint(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS));
  }
  releaseSavepoint(): Promise<void> {
    return Promise.reject(new Error(NO_TRANSACTIONS));
  }
}

class ExecutorDialect implements Dialect {
  constructor(private readonly tx: SqlExecutor) {}
  createDriver(): Driver {
    return new ExecutorDriver(this.tx);
  }
  createQueryCompiler() {
    return new PostgresQueryCompiler();
  }
  createAdapter() {
    return new PostgresAdapter();
  }
  createIntrospector(db: Kysely<unknown>) {
    return new PostgresIntrospector(db);
  }
}

const bound = new WeakMap<SqlExecutor, TypedDb>();

/**
 * Typed queries on the fixed tables, run through `tx` and so inside its
 * transaction, after `TENANT_PREAMBLE` for tenant transactions.
 *
 * Insert, update and delete results carry the affected-row counts
 * (`numInsertedOrUpdatedRows`, `numUpdatedRows`, `numDeletedRows`), limited
 * by row-level security to the tenant's rows like every other statement.
 *
 * The types come from `npm run db:types`. `date` columns come back as local midnight of
 * the Node process; read the calendar day with sql<string>`col::text`.
 */
export function typed(tx: SqlExecutor): TypedDb {
  let db = bound.get(tx);
  if (!db) {
    db = new Kysely<DB>({ dialect: new ExecutorDialect(tx) });
    bound.set(tx, db);
  }
  return db;
}
