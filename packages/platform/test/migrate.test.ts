import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { MIGRATION_LOCK_KEY, migrate, migrationStatus } from '../src/infrastructure/postgres/migrate.js';
import { PgDatabase } from '../src/infrastructure/postgres/pg-database.js';

const migrationsDir = join(import.meta.dirname, '../migrations');
const schemas: string[] = [];

function databaseUrl(): string {
  return inject('testDatabaseUrl' as never) as string;
}

async function withOwner<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function openSchema(): Promise<{ schema: string; db: PgDatabase }> {
  const schema = `${inject('testSchemaPrefix' as never) as string}m_${randomBytes(4).toString('hex')}`;
  schemas.push(schema);
  await withOwner((client) => client.query(`create schema ${schema}`));
  return { schema, db: new PgDatabase({ connectionString: databaseUrl(), schema, maxConnections: 1 }) };
}

async function relation(schema: string, name: string): Promise<string | null> {
  const [row] = (
    await withOwner((client) => client.query<{ name: string | null }>(`select to_regclass($1)::text as name`, [`${schema}.${name}`]))
  ).rows;
  return row?.name ?? null;
}

async function history(schema: string): Promise<string[]> {
  const { rows } = await withOwner((client) => client.query<{ name: string }>(`select name from ${schema}.kysely_migration order by name`));
  return rows.map((row) => row.name);
}

function withAppName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('application_name', name);
  return parsed.toString();
}

/** Backend running the stalled migration file, once it is inside its transaction. */
async function waitForStalledMigration(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] = (
      await withOwner((client) =>
        client.query<{ pid: number }>(
          `select pid from pg_stat_activity where application_name = 'ngo_migrate_crash' and state = 'active' and query like '%mig_b%'`,
        ),
      )
    ).rows;
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The migration never reached the stalled file.');
}

async function waitForBackendExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await withOwner((client) => client.query('select 1 from pg_stat_activity where pid = $1', [pid]));
    if (!rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Backend ${pid} did not exit.`);
}

async function lockHolders(): Promise<number[]> {
  const { rows } = await withOwner((client) =>
    client.query<{ pid: number }>(
      `select pid from pg_locks where locktype = 'advisory' and granted and objsubid = 1 and ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
      [MIGRATION_LOCK_KEY.toString()],
    ),
  );
  return rows.map((row) => row.pid);
}

afterEach(async () => {
  const pending = schemas.splice(0);
  if (!pending.length) return;
  await withOwner(async (client) => {
    for (const schema of pending) await client.query(`drop schema if exists ${schema} cascade`);
  });
});

describe('Kysely migrator', () => {
  it('runs each SQL file once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ngo-migrate-'));
    await writeFile(join(dir, '001_a.sql'), 'create table mig_a (id int);\n');
    await writeFile(join(dir, '002_b.sql'), 'create table mig_b (id int);\n');
    const { schema, db } = await openSchema();
    try {
      await expect(migrate(db, dir)).resolves.toEqual(['001_a.sql', '002_b.sql']);
      await expect(migrate(db, dir)).resolves.toEqual([]);
      expect(await relation(schema, 'mig_a')).toBe(`${schema}.mig_a`);
      expect(await relation(schema, 'mig_b')).toBe(`${schema}.mig_b`);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports pending and unknown migrations without applying them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ngo-migrate-'));
    await writeFile(join(dir, '001_a.sql'), 'create table mig_a (id int);\n');
    const { schema, db } = await openSchema();
    try {
      await expect(migrationStatus(db, dir)).resolves.toEqual({ pending: ['001_a.sql'], unknown: [] });
      expect(await relation(schema, 'kysely_migration')).toBeNull();
      await migrate(db, dir);
      await expect(migrationStatus(db, dir)).resolves.toEqual({ pending: [], unknown: [] });
      await writeFile(join(dir, '002_b.sql'), 'create table mig_b (id int);\n');
      await expect(migrationStatus(db, dir)).resolves.toEqual({ pending: ['002_b.sql'], unknown: [] });
      expect(await relation(schema, 'mig_b')).toBeNull();
      await rm(join(dir, '001_a.sql'));
      await expect(migrationStatus(db, dir)).resolves.toEqual({ pending: ['002_b.sql'], unknown: ['001_a.sql'] });
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps an already applied migration when its file is absent and the caller accepts it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ngo-migrate-'));
    await writeFile(join(dir, '001_a.sql'), 'create table mig_a (id int);\n');
    await writeFile(join(dir, '002_b.sql'), 'create table mig_b (id int);\n');
    const { schema, db } = await openSchema();
    try {
      await migrate(db, dir);
      await rm(join(dir, '002_b.sql'));
      await expect(migrate(db, dir)).rejects.toThrow(/corrupted migrations/);
      await expect(migrate(db, dir, ['002_b.sql'])).resolves.toEqual([]);
      expect(await history(schema)).toEqual(['001_a.sql', '002_b.sql']);
      expect(await relation(schema, 'mig_b')).toBe(`${schema}.mig_b`);
      await expect(migrationStatus(db, dir)).resolves.toEqual({ pending: [], unknown: ['002_b.sql'] });

      await writeFile(join(dir, '003_c.sql'), 'create table mig_c (id int);\n');
      await expect(migrate(db, dir, ['002_b.sql'])).resolves.toEqual(['003_c.sql']);
      expect(await relation(schema, 'mig_c')).toBe(`${schema}.mig_c`);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a new file that sorts before an accepted migration whose file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ngo-migrate-'));
    await writeFile(join(dir, '001_a.sql'), 'create table mig_a (id int);\n');
    await writeFile(join(dir, '003_c.sql'), 'create table mig_c (id int);\n');
    const { schema, db } = await openSchema();
    try {
      await migrate(db, dir);
      await rm(join(dir, '003_c.sql'));
      await writeFile(join(dir, '002_b.sql'), 'create table mig_b (id int);\n');
      await expect(migrate(db, dir, ['003_c.sql'])).rejects.toThrow(/corrupted migrations/);
      expect(await relation(schema, 'mig_b')).toBeNull();
      expect(await history(schema)).toEqual(['001_a.sql', '003_c.sql']);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file that sorts before the latest applied migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ngo-migrate-'));
    await writeFile(join(dir, '001_a.sql'), 'create table mig_a (id int);\n');
    await writeFile(join(dir, '003_c.sql'), 'create table mig_c (id int);\n');
    const { schema, db } = await openSchema();
    try {
      await migrate(db, dir);
      await writeFile(join(dir, '002_b.sql'), 'create table mig_b (id int);\n');
      await expect(migrate(db, dir)).rejects.toThrow(/corrupted migrations/);
      expect(await relation(schema, 'mig_b')).toBeNull();
      expect(await relation(schema, 'mig_a')).toBe(`${schema}.mig_a`);
      expect(await relation(schema, 'mig_c')).toBe(`${schema}.mig_c`);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs each file under the migration lock key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ngo-migrate-'));
    await writeFile(
      join(dir, '001_a.sql'),
      `do $$
       begin
         if not exists (
           select 1 from pg_locks
           where locktype = 'advisory' and pid = pg_backend_pid() and granted and objsubid = 1
             and ((classid::bigint << 32) | objid::bigint) = ${MIGRATION_LOCK_KEY}
         ) then
           raise exception 'migration lock not held';
         end if;
       end
       $$;\n`,
    );
    const { db } = await openSchema();
    try {
      await expect(migrate(db, dir)).resolves.toEqual(['001_a.sql']);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves neither the schema change nor the history row of a failing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ngo-migrate-'));
    await writeFile(join(dir, '001_a.sql'), 'create table mig_a (id int);\n');
    await writeFile(join(dir, '002_b.sql'), 'create table mig_b (id int);\nselect 1 / 0;\n');
    const { schema, db } = await openSchema();
    try {
      await expect(migrate(db, dir)).rejects.toThrow(/division by zero/);
      expect(await relation(schema, 'mig_a')).toBe(`${schema}.mig_a`);
      expect(await relation(schema, 'mig_b')).toBeNull();
      expect(await history(schema)).toEqual(['001_a.sql']);

      await writeFile(join(dir, '002_b.sql'), 'create table mig_b (id int);\n');
      await expect(migrate(db, dir)).resolves.toEqual(['002_b.sql']);
      expect(await relation(schema, 'mig_b')).toBe(`${schema}.mig_b`);
      expect(await history(schema)).toEqual(['001_a.sql', '002_b.sql']);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers after the process dies in the middle of a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ngo-migrate-'));
    await writeFile(join(dir, '001_a.sql'), 'create table mig_a (id int);\n');
    // Stalls only on the connection that is about to "crash".
    await writeFile(
      join(dir, '002_b.sql'),
      `create table mig_b (id int);\nselect pg_sleep(case when current_setting('application_name') = 'ngo_migrate_crash' then 60 else 0 end);\n`,
    );
    await writeFile(join(dir, '003_c.sql'), 'create table mig_c (id int);\n');
    const { schema } = await openSchema();
    const crashing = new PgDatabase({ connectionString: withAppName(databaseUrl(), 'ngo_migrate_crash'), schema, maxConnections: 1 });
    let pid: number;
    try {
      const run = migrate(crashing, dir).then(
        () => null,
        (error: unknown) => error,
      );
      pid = await waitForStalledMigration();
      await withOwner((client) => client.query('select pg_terminate_backend($1)', [pid]));
      expect(await run).toBeInstanceOf(Error);
    } finally {
      await crashing.close().catch(() => undefined);
    }
    await waitForBackendExit(pid);

    expect(await relation(schema, 'mig_a')).toBe(`${schema}.mig_a`);
    expect(await relation(schema, 'mig_b')).toBeNull();
    expect(await history(schema)).toEqual(['001_a.sql']);
    expect(await lockHolders()).not.toContain(pid);

    const restarted = new PgDatabase({ connectionString: databaseUrl(), schema, maxConnections: 1 });
    try {
      await expect(migrationStatus(restarted, dir)).resolves.toEqual({ pending: ['002_b.sql', '003_c.sql'], unknown: [] });
      await expect(migrate(restarted, dir)).resolves.toEqual(['002_b.sql', '003_c.sql']);
      expect(await relation(schema, 'mig_b')).toBe(`${schema}.mig_b`);
      expect(await relation(schema, 'mig_c')).toBe(`${schema}.mig_c`);
      expect(await history(schema)).toEqual(['001_a.sql', '002_b.sql', '003_c.sql']);
    } finally {
      await restarted.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('migrates two schemas at once, including the runtime role and pg_trgm', async () => {
    const first = await openSchema();
    const second = await openSchema();
    try {
      await Promise.all([migrate(first.db, migrationsDir), migrate(second.db, migrationsDir)]);
      expect(await relation(first.schema, 'tenant')).toBe(`${first.schema}.tenant`);
      expect(await relation(second.schema, 'tenant')).toBe(`${second.schema}.tenant`);
      const [role] = (await withOwner((client) => client.query(`select 1 from pg_roles where rolname = 'app_runtime'`))).rows;
      expect(role).toBeTruthy();
    } finally {
      await first.db.close();
      await second.db.close();
    }
  }, 180_000);
});
