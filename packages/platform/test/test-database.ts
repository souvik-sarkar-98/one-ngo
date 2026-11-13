import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { MIGRATION_LOCK_KEY } from '../src/infrastructure/postgres/migrate.js';

const DEFAULT_APP_URL = 'postgres://postgres@localhost:5432/ngo';

/** DATABASE_URL from the environment, else from .env, else the local default. */
export function appDatabaseUrl(): string {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const envFile = new URL('../.env', import.meta.url);
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*DATABASE_URL\s*=\s*(.*?)\s*$/.exec(line);
      const value = m?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
      if (value) return value;
    }
  }
  return DEFAULT_APP_URL;
}

/** The app's server and credentials, database `<name>_test`. */
export function testDatabaseUrl(): string {
  const url = new URL(appDatabaseUrl());
  const name = decodeURIComponent(url.pathname.slice(1)) || 'ngo';
  url.pathname = `/${name.endsWith('_test') ? name : `${name}_test`}`;
  return url.toString();
}

/**
 * A database of its own for one `db:types` run. kysely-codegen reads every
 * schema of the database it connects to and filters afterwards, so sharing the
 * test database makes it read the test worlds' schemas while other workers drop
 * them, and the run fails on a schema that has just gone.
 */
export function typesDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `${url.pathname}_types_${randomBytes(4).toString('hex')}`;
  return url.toString();
}

export async function withClient<T>(connectionString: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000 });
  try {
    await client.connect();
  } catch (error) {
    const reason = error instanceof Error ? error.message || (error as { code?: string }).code : String(error);
    throw new Error(`Tests need PostgreSQL at ${new URL(connectionString).host} (${reason}). Start it (npm run dev:setup does), or fix DATABASE_URL.`, {
      cause: error,
    });
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates the test database and the database-wide objects the migrations need,
 * so parallel workers and parallel checkouts never race on them. Returns its URL.
 */
export function prepareTestDatabase(): Promise<string> {
  return prepareDatabase(testDatabaseUrl());
}

function databaseName(url: string): { name: string; maintenance: string } {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`The test database name must be lowercase letters, digits and _ (got '${name}').`);
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  return { name, maintenance: maintenance.toString() };
}

/** Creates the database at `url` if missing, with the database-wide objects the migrations need. */
export async function prepareDatabase(url: string): Promise<string> {
  const { name, maintenance } = databaseName(url);
  await withClient(maintenance, async (c) => {
    const [exists] = (await c.query('select 1 from pg_database where datname = $1', [name])).rows;
    if (exists) return;
    // 42P04: another checkout created it first.
    await c.query(`create database ${name}`).catch((e: { code?: string }) => {
      if (e.code !== '42P04' && e.code !== '23505') throw e;
    });
  });
  // Test databases only: a crash may lose the last commits but never corrupts them.
  await withClient(maintenance, (c) => c.query(`alter database ${name} set synchronous_commit = off`));

  await withClient(url, async (c) => {
    await c.query('begin');
    // Migration 001 touches the same objects; the migrator holds this key around each file.
    await c.query('select pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK_KEY.toString()]);
    await c.query(`do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
          create role app_runtime nologin;
        end if;
      end
      $$`);
    await c.query(`do $$
      begin
        if exists (select 1 from pg_available_extensions where name = 'pg_trgm') then
          create extension if not exists pg_trgm schema public;
        end if;
      end
      $$`);
    await c.query('grant usage on schema public to app_runtime');
    await c.query('commit');
  });
  return url;
}

export async function dropDatabase(url: string): Promise<void> {
  const { name, maintenance } = databaseName(url);
  await withClient(maintenance, (c) => c.query(`drop database if exists ${name} with (force)`));
}

/**
 * Waits until nothing else is connected to the database at `url`, so dropping it
 * does not cut a connection a pool is still closing. Gives up at `timeoutMs`;
 * `dropDatabase()` forces the rest.
 */
export async function waitForNoConnections(url: string, timeoutMs = 10_000): Promise<void> {
  const { name, maintenance } = databaseName(url);
  const deadline = Date.now() + timeoutMs;
  await withClient(maintenance, async (c) => {
    for (;;) {
      const [row] = (await c.query<{ others: string }>('select count(*)::text as others from pg_stat_activity where datname = $1', [name])).rows;
      if (row?.others === '0' || Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
}

/** Drops every schema whose name starts with `prefix`. */
export async function dropSchemas(url: string, prefix: string): Promise<void> {
  await withClient(url, async (c) => {
    const left = (await c.query<{ nspname: string }>('select nspname from pg_namespace where left(nspname, length($1)) = $1', [prefix])).rows;
    for (const { nspname } of left) await c.query(`drop schema if exists ${nspname} cascade`);
  });
}
