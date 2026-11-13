import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Kysely, PostgresDialect, sql, type DatabaseIntrospector, type PostgresPool, type PostgresPoolClient, type TableMetadata } from 'kysely';
import { DEFAULT_MIGRATION_LOCK_TABLE, DEFAULT_MIGRATION_TABLE, Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type pg from 'pg';
import type { Database } from './db.js';
import { PgDatabase } from './pg-database.js';

/**
 * The session advisory lock Kysely's PostgreSQL migrator holds around each `migrateUp()`.
 * Anything else that creates database-wide objects the migrations touch takes it too.
 */
export const MIGRATION_LOCK_KEY = 3853314791062309107n;

async function migrationFiles(migrationsDir: string): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
}

class SqlFileMigrationProvider implements MigrationProvider {
  constructor(
    private readonly migrationsDir: string,
    /** Recorded by another release and accepted by the caller. Present so Kysely does not treat the history as corrupt; not run again. */
    private readonly acknowledged: readonly string[] = [],
  ) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const names = await migrationFiles(this.migrationsDir);
    const migrations: Record<string, Migration> = {};
    for (const name of names) {
      const text = await readFile(join(this.migrationsDir, name), 'utf8');
      migrations[name] = {
        async up(db) {
          // No parameters, so node-postgres uses the simple query protocol: one call runs
          // every statement in the file, including dollar-quoted bodies.
          await sql.raw(text).execute(db);
        },
      };
    }
    for (const name of this.acknowledged) {
      if (!migrations[name]) migrations[name] = { async up() {} };
    }
    return migrations;
  }
}

/** Hands Kysely's PostgreSQL dialect the one migrator connection; the database releases it afterwards. */
function singleConnection(client: pg.Client): PostgresPool {
  const connection = {
    query: (...args: unknown[]) => (client.query as (...a: unknown[]) => unknown)(...args),
    release() {},
  } as unknown as PostgresPoolClient;
  return { connect: async () => connection, end: async () => {}, options: {} };
}

/**
 * Before every `migrateUp()` the migrator asks whether its schema and two tables exist.
 * Kysely's introspector reads every column of every table in the database to answer, which
 * costs more than a small migration file on a test database holding many schemas. Used only
 * when the database names its own schema (test worlds, type generation); a database on the
 * default schema keeps Kysely's own introspector.
 */
class SchemaScopedKysely extends Kysely<any> {
  constructor(
    client: pg.Client,
    private readonly targetSchema: string,
  ) {
    super({ dialect: new PostgresDialect({ pool: singleConnection(client) }) });
  }

  override get introspection(): DatabaseIntrospector {
    const schema = this.targetSchema;
    return {
      getSchemas: async () => {
        const { rows } = await sql<{ name: string }>`
          select nspname as name from pg_catalog.pg_namespace where nspname = ${schema}`.execute(this);
        return rows;
      },
      getTables: async (): Promise<TableMetadata[]> => {
        const { rows } = await sql<{ name: string; schema: string }>`
          select c.relname as name, n.nspname as schema
          from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${schema}
            and c.relname in (${DEFAULT_MIGRATION_TABLE}, ${DEFAULT_MIGRATION_LOCK_TABLE})
            and c.relkind in ('r', 'p')`.execute(this);
        return rows.map((row) => ({ ...row, isView: false, isForeign: false, columns: [] }));
      },
    };
  }
}

function withKysely<T>(client: pg.Client, fn: (kysely: Kysely<any>) => Promise<T>, schema?: string): Promise<T> {
  const kysely = schema
    ? new SchemaScopedKysely(client, schema)
    : new Kysely<any>({ dialect: new PostgresDialect({ pool: singleConnection(client) }) });
  return fn(kysely).finally(() => kysely.destroy());
}

export interface MigrationStatus {
  /** Files in the migrations folder with no history row. */
  pending: string[];
  /** History rows with no file: the database was migrated by another version. */
  unknown: string[];
}

function pgDatabase(db: Database): PgDatabase {
  if (!(db instanceof PgDatabase)) throw new Error('Migrations run on the PostgreSQL database, not a joined transaction.');
  return db;
}

async function recordedMigrationNames(kysely: Kysely<any>, schema: string | undefined): Promise<string[]> {
  const table = schema ? `${schema}.kysely_migration` : 'kysely_migration';
  const { rows } = await sql<{ found: boolean }>`select to_regclass(${table}) is not null as found`.execute(kysely);
  if (!rows[0]?.found) return [];
  const history = await (schema ? kysely.withSchema(schema) : kysely).selectFrom('kysely_migration').select('name').execute();
  return history.map((row) => String(row.name));
}

/** Compares the migrations folder with `kysely_migration` without changing anything. */
export async function migrationStatus(db: Database, migrationsDir: string): Promise<MigrationStatus> {
  const database = pgDatabase(db);
  const { schema } = database.migratorTarget();
  const files = await migrationFiles(migrationsDir);
  const applied = await database.withMigratorClient((client) => withKysely(client, (kysely) => recordedMigrationNames(kysely, schema), schema));
  const recorded = new Set(applied);
  const known = new Set(files);
  return { pending: files.filter((f) => !recorded.has(f)), unknown: applied.filter((a) => !known.has(a)).sort() };
}

/**
 * Applies pending `migrations/*.sql` files through Kysely's migrator. Returns the names that ran.
 * One `migrateUp()` per file: each file and its history row commit together, and the lock is
 * held for one file at a time, so parallel test schemas interleave instead of queueing.
 *
 * `acknowledged` names a history row whose file this release does not have. Deployment passes
 * the unknown rows only after they are recorded as additive. Kysely would otherwise stop with
 * "previously executed migration is missing". A name that is not already recorded is ignored,
 * and a new file that sorts before the latest recorded name is still refused.
 */
export async function migrate(db: Database, migrationsDir: string, acknowledged: readonly string[] = []): Promise<string[]> {
  const database = pgDatabase(db);
  const target = database.migratorTarget();
  const files = await migrationFiles(migrationsDir);
  return database.withMigratorClient((client) =>
    withKysely(client, async (kysely) => {
      const known = new Set(files);
      const recorded = new Set(await recordedMigrationNames(kysely, target.schema));
      const placeholders = acknowledged.filter((name) => recorded.has(name) && !known.has(name));
      const migrator = new Migrator({
        db: kysely,
        provider: new SqlFileMigrationProvider(migrationsDir, placeholders),
        allowUnorderedMigrations: false,
        // Without this, Kysely treats a lock table in any schema as its own and skips creating one here.
        migrationTableSchema: target.schema,
      });
      const ran: string[] = [];
      for (;;) {
        const { error, results = [] } = await migrator.migrateUp();
        if (error) throw error;
        const applied = results.filter((result) => result.status === 'Success').map((result) => result.migrationName);
        if (!applied.length) return ran;
        ran.push(...applied);
      }
    }, target.schema),
  );
}
