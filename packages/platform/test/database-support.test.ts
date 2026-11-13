import { describe, expect, it, vi } from 'vitest';
import {
  checkDatabaseTarget,
  checkPostgresVersion,
  connectSupportedDatabase,
  installationMode,
  unsupportedFields,
  UnsupportedDatabaseError,
} from '../src/infrastructure/postgres/database-support.js';
import type { Database } from '../src/infrastructure/postgres/db.js';
import { openTestDatabase } from './helpers.js';

const SCHEME = 'Unsupported database: DATABASE_URL must be a PostgreSQL connection string (postgres:// or postgresql://).';
const MYSQL = 'Unsupported database: MySQL is not available in this version. Use PostgreSQL 15 or later.';
const MYSQL_SHARED = 'Unsupported combination: MySQL supports one-NGO installations only. Use PostgreSQL 15 or later for INSTALLATION_MODE=shared.';

const env = (DATABASE_URL: string, INSTALLATION_MODE?: string): NodeJS.ProcessEnv => ({ DATABASE_URL, INSTALLATION_MODE });

function refusal(fn: () => unknown): UnsupportedDatabaseError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedDatabaseError);
    return error as UnsupportedDatabaseError;
  }
  throw new Error('expected a refusal');
}

describe('installation mode', () => {
  it('defaults to one-ngo, accepts shared, and refuses anything else', () => {
    expect(installationMode({})).toBe('one-ngo');
    expect(installationMode({ INSTALLATION_MODE: ' ' })).toBe('one-ngo');
    expect(installationMode({ INSTALLATION_MODE: 'one-ngo' })).toBe('one-ngo');
    expect(installationMode({ INSTALLATION_MODE: 'shared' })).toBe('shared');
    for (const bad of ['Shared', 'multi', 'single']) {
      expect(refusal(() => installationMode({ INSTALLATION_MODE: bad })).message).toBe(
        'Unsupported INSTALLATION_MODE: use one-ngo (the default when unset) or shared.',
      );
    }
  });
});

describe('database scheme', () => {
  it('accepts PostgreSQL connection strings in either installation mode', () => {
    expect(checkDatabaseTarget(env('postgres://u:p@db.example:5432/ngo'))).toEqual({ scheme: 'postgres', mode: 'one-ngo' });
    expect(checkDatabaseTarget(env('postgresql://u:p@db.example/ngo', 'shared'))).toEqual({ scheme: 'postgresql', mode: 'shared' });
    expect(checkDatabaseTarget(env('POSTGRES://db.example/ngo'))).toEqual({ scheme: 'postgres', mode: 'one-ngo' });
  });

  it('refuses MySQL with the documented messages, by installation mode', () => {
    expect(refusal(() => checkDatabaseTarget(env('mysql://root:hunter2@db/ngo'))).message).toBe(MYSQL);
    expect(refusal(() => checkDatabaseTarget(env('mysql://root:hunter2@db/ngo', 'one-ngo'))).message).toBe(MYSQL);
    expect(refusal(() => checkDatabaseTarget(env('mysql://root:hunter2@db/ngo', 'shared'))).message).toBe(MYSQL_SHARED);
  });

  it('refuses every other scheme, and names at most the scheme, never the string', () => {
    for (const url of ['mariadb://root:hunter2@db/ngo', 'sqlserver://sa:hunter2@db', 'sqlite:///tmp/ngo.db', 'root:hunter2@db:5432/ngo', 'db.example']) {
      const error = refusal(() => checkDatabaseTarget(env(url)));
      expect(error.message).toBe(SCHEME);
      expect(JSON.stringify({ ...unsupportedFields(error), message: error.message })).not.toMatch(/hunter2|root|db\.example/);
    }
    expect(unsupportedFields(refusal(() => checkDatabaseTarget(env('mariadb://root:hunter2@db/ngo'))))).toEqual({ scheme: 'mariadb' });
    expect(unsupportedFields(refusal(() => checkDatabaseTarget(env('root:hunter2@db/ngo'))))).toEqual({});
  });

  it('checks the installation mode before the scheme', () => {
    expect(refusal(() => checkDatabaseTarget(env('mysql://db/ngo', 'multi'))).message).toMatch(/^Unsupported INSTALLATION_MODE/);
  });
});

describe('PostgreSQL version', () => {
  it('accepts 15 and later and names the version it refuses', () => {
    expect(() => checkPostgresVersion(150000, '15.0')).not.toThrow();
    expect(() => checkPostgresVersion(170002, '17.2 (Debian 17.2-1.pgdg120+1)')).not.toThrow();
    expect(refusal(() => checkPostgresVersion(140010, '14.10 (Ubuntu 14.10-0ubuntu0.22.04.1)')).message).toBe(
      'Unsupported database: PostgreSQL 15 or later is required (found 14.10).',
    );
    expect(refusal(() => checkPostgresVersion(Number.NaN, '')).message).toBe('Unsupported database: PostgreSQL 15 or later is required (found NaN).');
  });
});

describe('start-up check', () => {
  const fakeDb = (num: string, version: string) => {
    const close = vi.fn(async () => undefined);
    const db = { asSystem: async () => ({ num, version }), close } as unknown as Database;
    return { db, close };
  };

  it('never connects to a refused scheme or mode', async () => {
    const connect = vi.fn();
    await expect(connectSupportedDatabase(env('mysql://db/ngo', 'shared'), connect)).rejects.toThrow(MYSQL_SHARED);
    await expect(connectSupportedDatabase(env('mariadb://db/ngo'), connect)).rejects.toThrow(SCHEME);
    expect(connect).not.toHaveBeenCalled();
  });

  it('closes the connection and refuses a server older than 15, before anything else runs on it', async () => {
    const { db, close } = fakeDb('140010', '14.10');
    await expect(connectSupportedDatabase(env('postgres://db/ngo'), async () => db)).rejects.toThrow('PostgreSQL 15 or later is required (found 14.10)');
    expect(close).toHaveBeenCalledOnce();
  });

  it('passes the test server and returns the open database', async () => {
    const { db, dispose } = await openTestDatabase();
    try {
      const result = await connectSupportedDatabase(env('postgresql://test/ngo'), async () => db);
      expect(result.db).toBe(db);
      expect(result.target).toEqual({ scheme: 'postgresql', mode: 'one-ngo' });
    } finally {
      await dispose();
    }
  });
});
