import type { TransactionOptions, Tx } from '../ports/index.js';
import pg from 'pg';

export type { TransactionOptions, Tx } from '../ports/index.js';

export interface SqlResult<T> {
  rows: T[];
  affectedRows?: number;
}
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryWithRowCount<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
}
export interface MigratorTarget {
  connectionString: string;
  schema?: string;
}
export interface Database {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  migratorTarget(): MigratorTarget;
}

export interface PoolDatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  schema?: string;
}

/** Generic node-postgres pool with transaction lifecycle and no role or scope policy. */
export class PoolDatabase implements Database {
  private constructor(
    private readonly pool: pg.Pool,
    private readonly target: MigratorTarget,
  ) {}

  static async connect(options: PoolDatabaseOptions): Promise<PoolDatabase> {
    const pool = new pg.Pool({ connectionString: options.connectionString, max: options.maxConnections ?? 3 });
    const database = new PoolDatabase(pool, { connectionString: options.connectionString, schema: options.schema });
    await pool.query('select 1');
    return database;
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      if (options.isolation) await client.query(`set transaction isolation level ${options.isolation}`);
      if (options.readOnly) await client.query('set transaction read only');
      const executor: SqlExecutor = {
        query: async <R>(sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as R[],
        queryWithRowCount: async <R>(sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          return { rows: result.rows as R[], affectedRows: result.rowCount ?? undefined };
        },
      };
      const result = await fn(executor);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
  close(): Promise<void> {
    return this.pool.end();
  }
  migratorTarget(): MigratorTarget {
    return this.target;
  }
}

export const executorOf = (tx: Tx): SqlExecutor => tx as unknown as SqlExecutor;
export const asTx = (tx: SqlExecutor): Tx => tx as unknown as Tx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(value: string, label = 'id'): void {
  if (!UUID.test(value)) throw new TypeError(`${label} must be a UUID`);
}

export const UNIQUE_VIOLATION = '23505';
export const RAISE_EXCEPTION = 'P0001';
export interface DatabaseErrorInfo {
  code: string;
  message: string;
  constraint?: string;
}
export function databaseErrorOf(error: unknown, ignored?: abstract new (...args: never[]) => Error): DatabaseErrorInfo | undefined {
  if (!(error instanceof Error) || (ignored && error instanceof ignored)) return undefined;
  const { code, constraint } = error as Error & { code?: unknown; constraint?: unknown };
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return undefined;
  return { code, message: error.message, constraint: typeof constraint === 'string' ? constraint : undefined };
}
