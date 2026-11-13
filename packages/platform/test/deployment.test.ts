import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deployStepOptions, prepareDeployment, queueSensitiveFieldReencryption } from '../src/prepare-deployment.js';
import { decryptSecret, encryptSecret } from '@onengo/kernel/crypto';
import type { Database } from '../src/infrastructure/postgres/db.js';
import { MemoryLogger } from '@onengo/kernel/observability';
import { migrate } from '../src/infrastructure/postgres/migrate.js';
import { SERVER_SCHEMA_MINIMUMS } from '../src/infrastructure/postgres/schema-compatibility.js';
import { DefinitionService } from '../src/runtime/definitions/definition-service.js';
import { createPlatform, MIGRATIONS_DIR } from '../src/platform.js';
import { createWorld, openTestDatabase, type TestWorld } from './helpers.js';

const start = (db: Database) => createPlatform(db, { tokenSecret: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32), logger: new MemoryLogger() });

async function definitionVersions(db: Database): Promise<{ rows: number; published: string }> {
  const [row] = await db.asSystem((tx) =>
    tx.query<{ rows: number; published: string }>(
      `select count(*)::int as rows, string_agg(kind || '|' || key || '@' || version, ',' order by kind, key) filter (where status = 'published' and tenant_id is null) as published from definition`,
    ),
  );
  return row!;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshDatabase(): Promise<Database> {
  const { db, dispose } = await openTestDatabase();
  cleanups.push(dispose);
  return db;
}

async function world(): Promise<TestWorld> {
  const w = await createWorld();
  cleanups.push(() => w.close());
  return w;
}

describe('process start', () => {
  it('refuses a database that was never migrated, and says to run the deploy step', async () => {
    const db = await freshDatabase();
    await expect(start(db)).rejects.toThrow(new RegExp(`schema level 0 is below the minimum ${SERVER_SCHEMA_MINIMUMS.main}.*Run the deploy step`, 'i'));
  });

  it('starts when the only pending migration is above the recorded schema level', async () => {
    const db = await freshDatabase();
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const older = await mkdtemp(join(tmpdir(), 'ngo-migrations-'));
    cleanups.push(() => rm(older, { recursive: true, force: true }));
    for (const f of files.slice(0, -1)) await copyFile(join(MIGRATIONS_DIR, f), join(older, f));
    await migrate(db, older);
    await expect(start(db)).resolves.toBeTruthy();
  }, 60_000);

  it('refuses a database migrated by a newer version', async () => {
    const db = await freshDatabase();
    await prepareDeployment(db, { shippedModules: [] });
    await db.asSystem((tx) => tx.query(`insert into kysely_migration (name, timestamp) values ('999_future.sql', now()::text)`));
    await expect(start(db)).rejects.toThrow(/newer migration\(s\) without compatibility metadata/i);
  }, 60_000);

  it('on a prepared database publishes nothing new', async () => {
    const w = await world();
    const before = await definitionVersions(w.platform.db);
    const publishBase = vi.spyOn(DefinitionService.prototype, 'publishBase');
    const second = await start(w.platform.db);
    expect(second.definitions).not.toBe(w.platform.definitions);
    expect(publishBase).not.toHaveBeenCalled();
    expect(await definitionVersions(w.platform.db)).toEqual(before);
  });
});

describe('deploy step', () => {
  it('migrates, publishes the shipped modules, and reports what it did', async () => {
    const db = await freshDatabase();
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const result = await prepareDeployment(db);
    expect(result.migrations).toEqual(files);
    expect(result.modules.map((m) => m.manifest.key)).toEqual(['donations']);
    const { published } = await definitionVersions(db);
    expect(published).not.toMatch(/recordType\|person@/);
    expect(published).toMatch(/recordType\|donation@1/);
  }, 60_000);

  it('migrates when a newer additive migration is already recorded', async () => {
    const db = await freshDatabase();
    await prepareDeployment(db, { shippedModules: [] });
    await db.asSystem(async (tx) => {
      await tx.query(`insert into kysely_migration (name, timestamp) values ('099_future.sql', now()::text)`);
      await tx.query(`insert into schema_compatibility (schema_level, migration_name, compatibility) values (99, '099_future.sql', 'additive')`);
    });
    await expect(prepareDeployment(db, { shippedModules: [] })).resolves.toMatchObject({ migrations: [] });
    await expect(start(db)).resolves.toBeTruthy();
  }, 60_000);

  it('refuses to migrate over a newer breaking migration', async () => {
    const db = await freshDatabase();
    await prepareDeployment(db, { shippedModules: [] });
    await db.asSystem(async (tx) => {
      await tx.query(`insert into kysely_migration (name, timestamp) values ('099_rekey.sql', now()::text)`);
      await tx.query(`insert into schema_compatibility (schema_level, migration_name, compatibility) values (99, '099_rekey.sql', 'breaking')`);
    });
    await expect(prepareDeployment(db, { shippedModules: [] })).rejects.toThrow(/newer breaking migration/);
  }, 60_000);

  it('changes nothing when run again on a database with organisations', async () => {
    const w = await world();
    const before = await definitionVersions(w.platform.db);
    const again = await prepareDeployment(w.platform.db);
    expect(again).toMatchObject({ migrations: [] });
    expect(await definitionVersions(w.platform.db)).toEqual(before);
    await expect(start(w.platform.db)).resolves.toBeTruthy();
  });
});

describe('sensitive field re-encryption', () => {
  const reencryptJobs = async (db: Database) => {
    const [row] = await db.asSystem((tx) => tx.query<{ n: number }>(`select count(*)::int as n from job where kind = 'fields.reencrypt'`));
    return row!.n;
  };

  it('is an option of the deploy step only, and refuses unknown options', () => {
    expect(deployStepOptions([])).toEqual({ reencryptSensitiveFields: false });
    expect(deployStepOptions(['--reencrypt-sensitive-fields'])).toEqual({ reencryptSensitiveFields: true });
    expect(() => deployStepOptions(['--reencrypt'])).toThrow('Unknown deploy step option: --reencrypt. The only option is --reencrypt-sensitive-fields.');
  });

  it('queues one job per record type with stored sensitive values when asked, and none at normal start', async () => {
    const w = await world();
    const db = w.platform.db;
    await w.platform.records.create(w.as(w.ngoA), 'donor', { name: 'Asha', pan: 'ABCDE1234F', city: 'Pune' });
    const before = await reencryptJobs(db);
    await start(db);
    await prepareDeployment(db);
    expect(await reencryptJobs(db)).toBe(before);

    const queued = await queueSensitiveFieldReencryption(db, { encryptionKey: randomBytes(32) }, new MemoryLogger());
    expect(queued).toEqual({ organisations: 1, recordTypes: 1, twoStepSecrets: 0, connectorSecrets: 0 });
    expect(await reencryptJobs(db)).toBe(before + queued.recordTypes);

    const again = await queueSensitiveFieldReencryption(db, { encryptionKey: randomBytes(32) }, new MemoryLogger());
    expect(again).toEqual({ organisations: 0, recordTypes: 0, twoStepSecrets: 0, connectorSecrets: 0 });
  });

  it('rewrites two-step and connector secrets under the current key, so the old key can be removed', async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const w = await createWorld({ encryptionKey: oldKey, donations: false });
    cleanups.push(() => w.close());
    const db = w.platform.db;
    const [user] = await db.asSystem((tx) =>
      tx.query<{ id: string }>(`insert into app_user (email, display_name, totp_secret_enc) values ('rotate@ngo.test', 'Rotate', $1) returning id`, [
        encryptSecret('TOTPSECRET', oldKey),
      ]),
    );
    await db.asSystem(async (tx) => {
      await tx.query(`insert into connector (tenant_id, key, type, secret_enc) values ($1, 'hook', 'webhook', $2)`, [w.ngoA, encryptSecret('{"s":"hook"}', oldKey)]);
    });
    const stored = async () => {
      const [u] = await db.asSystem((tx) => tx.query<{ v: string }>(`select totp_secret_enc as v from app_user where id = $1`, [user!.id]));
      const [c] = await db.asSystem((tx) => tx.query<{ v: string }>(`select secret_enc as v from connector where tenant_id = $1 and key = 'hook'`, [w.ngoA]));
      return [u!.v, c!.v];
    };

    await expect(queueSensitiveFieldReencryption(db, { encryptionKey: newKey }, new MemoryLogger())).rejects.toThrow(/ENCRYPTION_KEY_PREVIOUS/);
    const queued = await queueSensitiveFieldReencryption(db, { encryptionKey: newKey, previousEncryptionKeys: [oldKey] }, new MemoryLogger());
    expect(queued).toMatchObject({ twoStepSecrets: 1, connectorSecrets: 1 });
    const [totp, hook] = await stored();
    expect(decryptSecret(totp!, newKey)).toBe('TOTPSECRET');
    expect(decryptSecret(hook!, newKey)).toBe('{"s":"hook"}');
    const again = await queueSensitiveFieldReencryption(db, { encryptionKey: newKey }, new MemoryLogger());
    expect(again).toMatchObject({ twoStepSecrets: 0, connectorSecrets: 0 });
  });
});
