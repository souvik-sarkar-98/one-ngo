import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { assertUuid, TENANT_PREAMBLE, type Database, type SqlExecutor, type SqlResult, type TransactionOptions } from './db.js';

export interface PgDatabaseOptions {
  connectionString: string;
  /**
   * Optional login for tenant transactions: a member of `app_runtime` that owns
   * nothing. Unset, tenant transactions use `connectionString` too.
   */
  runtimeConnectionString?: string;
  /** Free hosted PostgreSQL tiers allow few connections; keep this small. Each pool gets this many. */
  maxConnections?: number;
  /** Schema to work in, for isolated test schemas. Defaults to the server's search path. */
  schema?: string;
}

/** `DATABASE_URL`, e.g. postgres://postgres@localhost:5432/ngo. */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL to a PostgreSQL database, e.g. postgres://postgres@localhost:5432/ngo.');
  return url;
}

/** `DATABASE_RUNTIME_URL`, the optional non-owner login for tenant traffic; undefined when unset. */
export function runtimeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DATABASE_RUNTIME_URL?.trim() || undefined;
}

/** Host, port and database of a connection string, without credentials. */
function describe(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  } catch {
    return 'DATABASE_URL';
  }
}

/** Session settings shared by the pool and the short-lived migrator connection. */
export function pgSessionOptions(schema?: string): string {
  if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid schema name.');
  return ['-c TimeZone=UTC', ...(schema ? [`-c search_path=${schema},public`] : [])].join(' ');
}

const COUNTED_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

const ISOLATION_LEVELS = new Set(['read committed', 'repeatable read', 'serializable']);

function beginStatement({ isolation, readOnly }: TransactionOptions = {}): string {
  if (isolation !== undefined && !ISOLATION_LEVELS.has(isolation)) throw new Error('Invalid isolation level.');
  const modes = [...(isolation ? [`isolation level ${isolation}`] : []), ...(readOnly ? ['read only'] : [])];
  return modes.length ? `begin ${modes.join(', ')}` : 'begin';
}

interface RuntimeRole {
  login: string;
  superuser: boolean;
  bypassRls: boolean;
  runtimeMember: boolean;
}

/**
 * Why the tenant login must not serve tenant traffic, or null when it may: it
 * must be a member of `app_runtime` and neither a superuser, nor able to bypass
 * row-level security, nor the owner (or a member of the owner).
 */
export function runtimeRoleProblem(role: RuntimeRole, owner: string, ownsOrActsAsOwner: boolean): string | null {
  if (role.superuser) return `the runtime login ${role.login} is a superuser`;
  if (role.bypassRls) return `the runtime login ${role.login} bypasses row-level security`;
  if (role.login === owner || ownsOrActsAsOwner) return `the runtime login ${role.login} is, or acts as, the owner ${owner}`;
  if (!role.runtimeMember) return `the runtime login ${role.login} is not a member of app_runtime (grant app_runtime to ${role.login})`;
  return null;
}

/** node-postgres adapter for local and hosted PostgreSQL (Supabase, Neon, Cloud SQL). */
export class PgDatabase implements Database {
  private readonly pool: pg.Pool;
  /** Tenant transactions; the owner pool unless a runtime login is configured. */
  private readonly runtimePool: pg.Pool;
  private readonly target: { connectionString: string; schema?: string };
  /** Presented to app_bind_tenant; only its hash is stored, by the owner (migration 026). */
  private readonly bindKey = randomBytes(32).toString('hex');
  private bindKeyRegistered: Promise<void> | undefined;

  /** Opens the pool and checks the server answers, so a stopped server fails at start-up with a clear message. */
  static async connect(options: PgDatabaseOptions): Promise<PgDatabase> {
    const db = new PgDatabase(options);
    try {
      await db.one(db.pool, 'select 1');
    } catch (error) {
      await db.close().catch(() => undefined);
      const reason = error instanceof Error ? error.message || (error as { code?: string }).code || error.name : String(error);
      throw new Error(`Cannot reach PostgreSQL at ${describe(options.connectionString)} (${reason}). Start PostgreSQL (npm run dev does) or fix DATABASE_URL.`, {
        cause: error,
      });
    }
    if (options.runtimeConnectionString) {
      try {
        await db.assertRuntimeRole();
      } catch (error) {
        await db.close().catch(() => undefined);
        throw error;
      }
    }
    return db;
  }

  constructor(options: PgDatabaseOptions) {
    this.target = { connectionString: options.connectionString, schema: options.schema };
    const pool = (connectionString: string) =>
      new pg.Pool({
        connectionString,
        max: options.maxConnections ?? 3,
        idleTimeoutMillis: 10_000,
        // Day boundaries (date filters, fiscal periods) are UTC as on hosted PostgreSQL, whatever the server's own zone.
        options: pgSessionOptions(options.schema),
      });
    this.pool = pool(options.connectionString);
    this.runtimePool = options.runtimeConnectionString ? pool(options.runtimeConnectionString) : this.pool;
  }

  /** Whether tenant transactions use a separate runtime login. */
  get separateRuntimeLogin(): boolean {
    return this.runtimePool !== this.pool;
  }

  /** Refuses a runtime login that could defeat row-level security (S4-14). */
  async assertRuntimeRole(): Promise<void> {
    const [role] = (
      await this.one<RuntimeRole>(
        this.runtimePool,
        `select current_user::text as login, r.rolsuper as superuser, r.rolbypassrls as "bypassRls",
                case when exists (select 1 from pg_roles a where a.rolname = 'app_runtime') then pg_has_role(current_user, 'app_runtime', 'member') else false end as "runtimeMember"
           from pg_roles r where r.rolname = current_user`,
      )
    ).rows;
    const [owner] = (
      await this.one<{ owner: string; acts: boolean }>(
        this.pool,
        `select current_user::text as owner, pg_has_role($1::name, current_user, 'member') as acts`,
        [role!.login],
      )
    ).rows;
    const problem = runtimeRoleProblem(role!, owner!.owner, owner!.acts);
    if (problem) throw new Error(`Refusing DATABASE_RUNTIME_URL: ${problem}.`);
  }

  migratorTarget() {
    return this.target;
  }

  /** One pool connection for the migrator, released afterwards. No second connection. */
  async withMigratorClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // A lost connection already fails the running query; unheard, its socket error would also end the process.
    let lost: Error | undefined;
    const onError = (error: Error) => {
      lost = error;
    };
    client.on('error', onError);
    try {
      return await fn(client);
    } finally {
      client.removeListener('error', onError);
      client.release(lost);
    }
  }

  async withTenant<T>(tenantId: string, fn: (tx: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T> {
    assertUuid(tenantId, 'tenantId');
    await this.registerBindKey();
    return this.transaction(
      this.runtimePool,
      async (tx) => {
        await tx.query(TENANT_PREAMBLE[0]);
        await tx.query(TENANT_PREAMBLE[1], [tenantId, this.bindKey]);
        return fn(tx);
      },
      options,
    );
  }

  asSystem<T>(fn: (tx: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return this.transaction(this.pool, fn, options);
  }

  async exec(sql: string): Promise<void> {
    await this.one(this.pool, sql);
  }

  async close(): Promise<void> {
    if (this.bindKeyRegistered) {
      await this.bindKeyRegistered
        .then(() => this.one(this.pool, 'select app_unregister_tenant_bind_key($1)', [this.bindKeyHash()]))
        .catch(() => undefined);
    }
    await this.pool.end();
    if (this.runtimePool !== this.pool) await this.runtimePool.end();
  }

  private bindKeyHash(): string {
    return createHash('sha256').update(this.bindKey, 'utf8').digest('hex');
  }

  /** The control role registers this process's key without direct table access. */
  private registerBindKey(): Promise<void> {
    this.bindKeyRegistered ??= this.one(this.pool, 'select app_register_tenant_bind_key($1)', [this.bindKeyHash()]).then(
      () => undefined,
      (error: unknown) => {
        this.bindKeyRegistered = undefined;
        throw error;
      },
    );
    return this.bindKeyRegistered;
  }

  private one<R extends pg.QueryResultRow = pg.QueryResultRow>(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    return pool.query<R>(sql, params);
  }

  private async transaction<T>(pool: pg.Pool, fn: (tx: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const begin = beginStatement(options);
    const client = await pool.connect();
    const run = async <R>(sql: string, params: unknown[] = []): Promise<SqlResult<R>> => {
      const result = await client.query(sql, params);
      const counted = COUNTED_COMMANDS.has(result.command) && result.rowCount !== null;
      return { rows: result.rows as R[], affectedRows: counted ? (result.rowCount as number) : undefined };
    };
    const tx: SqlExecutor = {
      async query<R>(sql: string, params?: unknown[]) {
        return (await run<R>(sql, params)).rows;
      },
      queryWithRowCount: run,
    };
    try {
      await client.query(begin);
      const value = await fn(tx);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
