import { sql } from 'kysely';
import type { Database } from './db.js';
import { typed } from './kysely.js';
import { databaseUrl } from './pg-database.js';

/** `INSTALLATION_MODE`: unset or empty means `one-ngo`. */
export const INSTALLATION_MODES = ['one-ngo', 'shared'] as const;
export type InstallationMode = (typeof INSTALLATION_MODES)[number];

export const MIN_POSTGRES_MAJOR = 15;

export const UNSUPPORTED = {
  scheme: 'Unsupported database: DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://).',
  mysql: 'Unsupported database: MySQL is not available in this version. Use PostgreSQL 15 or later.',
  mysqlShared: 'Unsupported combination: MySQL supports one-NGO installations only. Use PostgreSQL 15 or later for INSTALLATION_MODE=shared.',
  mode: 'Unsupported INSTALLATION_MODE: use one-ngo (the default when unset) or shared.',
  version: (found: string) => `Unsupported database: PostgreSQL 15 or later is required (found ${found}).`,
} as const;

/** The refusal of a database or installation mode; it names the scheme at most, never the connection string. */
export class UnsupportedDatabaseError extends Error {
  constructor(
    message: string,
    readonly scheme?: string,
  ) {
    super(message);
    this.name = 'UnsupportedDatabaseError';
  }
}

/** Log fields for a start-up failure: the refused scheme, if any. */
export function unsupportedFields(error: unknown): { scheme?: string } {
  return error instanceof UnsupportedDatabaseError && error.scheme ? { scheme: error.scheme } : {};
}

export interface DatabaseTarget {
  /** `postgres` or `postgresql`. */
  scheme: string;
  mode: InstallationMode;
}

export function installationMode(env: NodeJS.ProcessEnv = process.env): InstallationMode {
  const value = env.INSTALLATION_MODE?.trim() ?? '';
  if (!value) return 'one-ngo';
  if (!(INSTALLATION_MODES as readonly string[]).includes(value)) throw new UnsupportedDatabaseError(UNSUPPORTED.mode);
  return value as InstallationMode;
}

/** Only a `<letters>://` prefix counts as a scheme, so a malformed string never has a credential mistaken for one. */
function schemeOf(url: string): string | undefined {
  return /^([a-z][a-z0-9+.-]{0,30}):\/\//i.exec(url)?.[1]?.toLowerCase();
}

/** Checks `DATABASE_URL`'s scheme and `INSTALLATION_MODE` before any connection is opened. */
export function checkDatabaseTarget(env: NodeJS.ProcessEnv = process.env): DatabaseTarget {
  const mode = installationMode(env);
  const scheme = schemeOf(databaseUrl(env));
  if (scheme === 'postgres' || scheme === 'postgresql') return { scheme, mode };
  if (scheme === 'mysql') throw new UnsupportedDatabaseError(mode === 'shared' ? UNSUPPORTED.mysqlShared : UNSUPPORTED.mysql, scheme);
  throw new UnsupportedDatabaseError(UNSUPPORTED.scheme, scheme);
}

/** `server_version_num` (e.g. 150004) and `server_version` (e.g. `15.4 (Debian 15.4-1)`) as the server reports them. */
export function checkPostgresVersion(versionNum: number, version: string): void {
  if (Number.isInteger(versionNum) && Math.floor(versionNum / 10_000) >= MIN_POSTGRES_MAJOR) return;
  throw new UnsupportedDatabaseError(UNSUPPORTED.version(version.trim().split(/\s+/)[0] || String(versionNum)), 'postgres');
}

export async function assertSupportedServer(db: Database): Promise<void> {
  const row = await db.asSystem((tx) =>
    sql<{ num: string; version: string }>`select current_setting('server_version_num') as num, current_setting('server_version') as version`
      .execute(typed(tx))
      .then((r) => r.rows[0]!),
  );
  checkPostgresVersion(Number(row.num), row.version);
}

/**
 * The start-up check of the server and the deploy step: the scheme and
 * installation mode before connecting, the server version right after, so
 * nothing runs against, or migrates, an unsupported database. A refused
 * connection is closed before the error is thrown.
 */
export async function connectSupportedDatabase<T extends Database>(
  env: NodeJS.ProcessEnv,
  connect: (connectionString: string) => Promise<T>,
): Promise<{ db: T; target: DatabaseTarget }> {
  const target = checkDatabaseTarget(env);
  const db = await connect(databaseUrl(env));
  try {
    await assertSupportedServer(db);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return { db, target };
}
