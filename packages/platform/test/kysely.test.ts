import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sql, type Insertable, type Selectable } from 'kysely';
import { afterAll, beforeAll, describe, expect, expectTypeOf, inject, it } from 'vitest';
import { generateDbTypes, TYPES_FILE } from '../scripts/db-types.js';
import { writeAudit } from '../src/infrastructure/postgres/stores/audit-store.js';
import type { JobActor, JobData, OutboxPayload } from '../src/infrastructure/postgres/db-json.js';
import type { DB, Json } from '../src/infrastructure/postgres/db-types.js';
import { joinTransaction, type Database, type SqlExecutor } from '../src/infrastructure/postgres/db.js';
import { typed } from '../src/infrastructure/postgres/kysely.js';
import { admin, createWorld, currentFiscalYear, type TestWorld } from './helpers.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

const root = join(import.meta.dirname, '..');
const workspace = join(root, '../..');
const run = promisify(execFile);
const schemaName = () => `${inject('testSchemaPrefix' as never) as string}types_${randomBytes(4).toString('hex')}`;

async function dbTypesCli(...args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [join(workspace, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/db-types.ts'), ...args], {
      cwd: workspace,
      timeout: 150_000,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, output: (e.stdout ?? '') + (e.stderr ?? String(error)) };
  }
}

describe('generated database types', () => {
  it('npm run db:types -- --verify passes on the checked-in file', async () => {
    const result = await dbTypesCli('--verify', '--schema', schemaName());
    expect(result.output).toContain('is up to date');
    expect(result.code).toBe(0);
  }, 180_000);

  it('--verify fails when a migration is added without regenerating', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ngo-migrations-'));
    try {
      cpSync(join(root, 'migrations'), dir, { recursive: true });
      writeFileSync(join(dir, '999_kysely_probe.sql'), 'alter table tenant add column kysely_probe text;\n');
      await expect(generateDbTypes({ schema: schemaName(), migrationsDir: dir, verify: true })).rejects.toThrow(/not up-to-date/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(readFileSync(TYPES_FILE, 'utf8')).not.toContain('kysely_probe');
  }, 180_000);

  it("covers every fixed table and leaves out the migrator's own", () => {
    const text = readFileSync(TYPES_FILE, 'utf8');
    const db = /export interface DB \{\n([^}]*)\}/.exec(text)![1]!;
    const tables = [...db.matchAll(/^ {2}(\w+): \w+;$/gm)].map((m) => m[1]!);
    expect(tables).toHaveLength(77);
    expect(tables).toEqual(
      expect.arrayContaining([
        'tenant', 'app_user', 'tenant_member', 'role', 'definition', 'record', 'record_link', 'job', 'journal_entry', 'receipt',
        'organisation_profile', 'organisation_registration', 'tenant_asset', 'organisation_onboarding', 'platform_audit', 'receipt_issuer', 'receipt_content',
        'consent_event', 'erasure_request', 'connector_oauth_state', 'passkey_credential', 'passkey_challenge',
        'migration_profile', 'migration_source', 'migration_key',
      ]),
    );
    expect(text).not.toMatch(/kysely_migration|schema_migration/);
  });

  it('types numeric and int8 as strings, JSON as text in and Json out, and the stored JSON by its shape', () => {
    type Row<T extends keyof DB> = Selectable<DB[T]>;
    expectTypeOf<Row<'receipt'>['amount']>().toEqualTypeOf<string>();
    expectTypeOf<Row<'journal_line'>['debit']>().toEqualTypeOf<string>();
    expectTypeOf<Row<'receipt'>['seq']>().toEqualTypeOf<string>();
    expectTypeOf<Row<'file_object'>['size']>().toEqualTypeOf<string>();
    expectTypeOf<Row<'audit_event'>['id']>().toEqualTypeOf<string>();
    expectTypeOf<Row<'role'>['customised']>().toEqualTypeOf<boolean>();
    expectTypeOf<Row<'fiscal_period'>['starts_on']>().toEqualTypeOf<Date>();
    expectTypeOf<Row<'tenant_setting'>['value']>().toEqualTypeOf<Json>();
    expectTypeOf<Insertable<DB['tenant_setting']>['value']>().toEqualTypeOf<string>();
    expectTypeOf<Row<'job'>['actor']>().toEqualTypeOf<JobActor>();
    expectTypeOf<Row<'job'>['input']>().toEqualTypeOf<JobData>();
    expectTypeOf<Row<'job'>['state']>().toEqualTypeOf<JobData>();
    expectTypeOf<Row<'job'>['result']>().toEqualTypeOf<JobData | null>();
    expectTypeOf<Insertable<DB['job']>['state']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Row<'outbox_event'>['payload']>().toEqualTypeOf<OutboxPayload>();
    expectTypeOf<Insertable<DB['outbox_event']>['payload']>().toEqualTypeOf<string>();
  });
});

describe('typed(tx) on the transaction executor', () => {
  let world: TestWorld;
  let db: Database;
  beforeAll(async () => {
    world = await createWorld({ donations: false });
    db = world.platform.db;
  });
  afterAll(() => world?.close());

  const setting = (tenantId: string, key: string) =>
    db.withTenant(tenantId, (tx) => typed(tx).selectFrom('tenant_setting').select(['key', 'value']).where('key', '=', key).executeTakeFirst());

  describe('runtime shapes match the generated types', () => {
    /** The select type kysely-codegen writes for each PostgreSQL type the migrations use (.kysely-codegenrc.json). */
    const GENERATED: Record<string, string> = {
      uuid: 'string',
      text: 'string',
      varchar: 'string',
      bpchar: 'string',
      int2: 'number',
      int4: 'number',
      int8: 'string',
      numeric: 'string',
      bool: 'boolean',
      timestamptz: 'Date',
      date: 'Date',
      jsonb: 'Json',
      json: 'Json',
    };
    /** Array element types node-postgres parses into JS arrays of the same shape. */
    const ARRAY_ELEMENTS = new Set(['uuid', 'text', 'varchar', 'int2', 'int4', 'bool']);
    const shapes: Record<string, (v: unknown) => boolean> = {
      string: (v) => typeof v === 'string',
      number: (v) => typeof v === 'number',
      boolean: (v) => typeof v === 'boolean',
      Date: (v) => v instanceof Date && !Number.isNaN(v.getTime()),
      Json: (v) => typeof v === 'object' && v !== null && !(v instanceof Date),
    };
    const samples: Record<string, string> = {
      uuid: 'gen_random_uuid()',
      text: `'x'`,
      varchar: `'x'`,
      bpchar: `'x'`,
      int2: '1',
      int4: '1',
      int8: '9007199254740993',
      numeric: '12.50',
      bool: 'true',
      timestamptz: 'now()',
      date: 'current_date',
      jsonb: `'{"a":[1]}'`,
      json: `'{"a":[1]}'`,
    };

    it('returns each PostgreSQL type as the type kysely-codegen writes', async () => {
      expect(Object.keys(samples).sort()).toEqual(Object.keys(GENERATED).sort());
      const select = Object.keys(GENERATED).map((t) => `${samples[t]}::${t} as "${t}", array[${samples[t]}]::${t}[] as "${t}[]", null::${t} as "${t}?"`);
      const [row] = await db.asSystem((tx) => tx.query<Record<string, unknown>>(`select ${select.join(', ')}`));
      for (const [type, generated] of Object.entries(GENERATED)) {
        expect(shapes[generated]!(row![type]), `${type} -> ${generated}`).toBe(true);
        expect(row![`${type}?`], `${type} null`).toBeNull();
        if (ARRAY_ELEMENTS.has(type)) {
          const array = row![`${type}[]`] as unknown[];
          expect(Array.isArray(array) && array.every(shapes[generated]!), `${type}[]`).toBe(true);
        }
      }
      expect(row!.int8).toBe('9007199254740993');
      expect(row!.numeric).toBe('12.50');
    });

    it('returns a date as local midnight of the Node process, so the day is read as text', async () => {
      const [row] = await db.asSystem((tx) => tx.query<{ d: Date; t: string }>(`select '2026-04-01'::date as d, '2026-04-01'::date::text as t`));
      expect(row!.d.getTime()).toBe(new Date(2026, 3, 1).getTime());
      expect(row!.t).toBe('2026-04-01');
    });

    it('reads real columns through typed(tx) with their generated types', async () => {
      const rows = await db.asSystem(async (tx) => {
        const k = typed(tx);
        const tenant = await k
          .selectFrom('tenant')
          .select(['id', 'key', 'region', 'config_version', 'created_at', 'last_tick_at'])
          .where('id', '=', world.ngoA)
          .executeTakeFirstOrThrow();
        const role = await k
          .insertInto('role')
          .values({ tenant_id: world.ngoA, key: 'kysely_probe', label: 'Probe', permissions: ['record:x:read', 'record:x:update'] })
          .returning(['permissions', 'customised'])
          .executeTakeFirstOrThrow();
        const counter = await k
          .insertInto('sequence_counter')
          .values({ tenant_id: world.ngoA, key: 'probe', period: '2026', next_value: '9007199254740993' })
          .returning('next_value')
          .executeTakeFirstOrThrow();
        return { tenant, role, counter };
      });
      expectTypeOf(rows.tenant.id).toEqualTypeOf<string>();
      expectTypeOf(rows.tenant.region).toEqualTypeOf<string | null>();
      expectTypeOf(rows.tenant.config_version).toEqualTypeOf<number>();
      expectTypeOf(rows.tenant.created_at).toEqualTypeOf<Date>();
      expectTypeOf(rows.tenant.last_tick_at).toEqualTypeOf<Date | null>();
      expectTypeOf(rows.role.permissions).toEqualTypeOf<string[]>();
      expectTypeOf(rows.counter.next_value).toEqualTypeOf<string>();
      expect(rows.tenant).toMatchObject({ id: world.ngoA, key: 'asha', region: 'asia-south1', config_version: expect.any(Number), last_tick_at: null });
      expect(rows.tenant.created_at).toBeInstanceOf(Date);
      expect(rows.role).toEqual({ permissions: ['record:x:read', 'record:x:update'], customised: false });
      expect(rows.counter.next_value).toBe('9007199254740993');

      await db.withTenant(world.ngoA, (tx) => world.platform.ledger.openFiscalYear(asTx(tx), admin, currentFiscalYear()));
      const period = await db.withTenant(world.ngoA, (tx) =>
        typed(tx).selectFrom('fiscal_period').select(['starts_on', sql<string>`starts_on::text`.as('day')]).executeTakeFirstOrThrow(),
      );
      expectTypeOf(period.starts_on).toEqualTypeOf<Date>();
      expect(period.starts_on).toBeInstanceOf(Date);
      expect(period.day).toMatch(/^\d{4}-04-01$/);

      await db.withTenant(world.ngoA, (tx) => writeAudit(tx, { actorId: admin.id, action: 'probe', entity: 'kysely', entityId: 'e1', after: [1, { a: null }] }));
      const audit = await db.withTenant(world.ngoA, (tx) =>
        typed(tx).selectFrom('audit_event').select(['id', 'tenant_id', 'before', 'after', 'at']).where('entity', '=', 'kysely').executeTakeFirstOrThrow(),
      );
      expectTypeOf(audit.id).toEqualTypeOf<string>();
      expectTypeOf(audit.after).toEqualTypeOf<Json | null>();
      expectTypeOf<Selectable<DB['audit_event']>['at']>().toEqualTypeOf<Date>();
      expect(audit).toMatchObject({ id: expect.stringMatching(/^\d+$/), tenant_id: world.ngoA, before: null, after: [1, { a: null }] });
      expect(audit.at).toBeInstanceOf(Date);
    });
  });

  describe('transactions', () => {
    it('runs tenant queries after the preamble, mixed with raw SQL', async () => {
      const seen = await db.withTenant(world.ngoA, async (tx) => {
        const k = typed(tx);
        expect(typed(tx)).toBe(k);
        const { rows } = await sql<{ role: string; tenant: string }>`select current_user as role, current_setting('app.tenant_id') as tenant`.execute(k);
        await k.insertInto('tenant_setting').values({ tenant_id: world.ngoA, key: 'k.mixed', value: JSON.stringify({ on: true }) }).execute();
        const raw = await tx.query<{ value: unknown }>(`select value from tenant_setting where key = 'k.mixed'`);
        return { session: rows[0], raw };
      });
      expect(seen.session).toEqual({ role: 'app_runtime', tenant: world.ngoA });
      expect(seen.raw).toEqual([{ value: { on: true } }]);
      expect(await setting(world.ngoA, 'k.mixed')).toEqual({ key: 'k.mixed', value: { on: true } });
    });

    it('runs system queries as the owner across tenants', async () => {
      const tenants = await db.asSystem((tx) =>
        typed(tx).selectFrom('tenant').select('key').where('id', 'in', [world.ngoA, world.ngoB]).orderBy('key').execute(),
      );
      expect(tenants).toEqual([{ key: 'asha' }, { key: 'bodhi' }]);
    });

    it('rolls back Kysely writes when withTenant() fails', async () => {
      await expect(
        db.withTenant(world.ngoA, async (tx) => {
          await typed(tx).insertInto('tenant_setting').values({ tenant_id: world.ngoA, key: 'k.rollback', value: '1' }).execute();
          expect((await typed(tx).selectFrom('tenant_setting').select('key').where('key', '=', 'k.rollback').execute()).length).toBe(1);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await setting(world.ngoA, 'k.rollback')).toBeUndefined();
    });

    it('keeps joinTransaction() one unit for typed and raw writes', async () => {
      const work = (fail: boolean, key: string) =>
        db.withTenant(world.ngoA, async (tx) => {
          const joined = joinTransaction(world.ngoA, tx);
          await joined.withTenant(world.ngoA, (t) => typed(t).insertInto('tenant_setting').values({ tenant_id: world.ngoA, key: `${key}.typed`, value: '1' }).execute());
          await joined.withTenant(world.ngoA, (t) => t.query(`insert into tenant_setting (tenant_id, key, value) values (app_tenant(), $1, '2')`, [`${key}.raw`]));
          if (fail) throw new Error('boom');
        });
      await expect(work(true, 'k.joinfail')).rejects.toThrow('boom');
      expect(await setting(world.ngoA, 'k.joinfail.typed')).toBeUndefined();
      expect(await setting(world.ngoA, 'k.joinfail.raw')).toBeUndefined();
      await work(false, 'k.join');
      expect(await setting(world.ngoA, 'k.join.typed')).toEqual({ key: 'k.join.typed', value: 1 });
      expect(await setting(world.ngoA, 'k.join.raw')).toEqual({ key: 'k.join.raw', value: 2 });
    });

    it("refuses Kysely's own transactions and leaves the open one usable", async () => {
      const value = await db.withTenant(world.ngoA, async (tx) => {
        const k = typed(tx);
        await expect(k.transaction().execute(async () => 1)).rejects.toThrow(/withTenant\(\)/);
        await expect(k.startTransaction().execute()).rejects.toThrow(/withTenant\(\)/);
        await k.insertInto('tenant_setting').values({ tenant_id: world.ngoA, key: 'k.after', value: '3' }).execute();
        return 'committed';
      });
      expect(value).toBe('committed');
      expect(await setting(world.ngoA, 'k.after')).toEqual({ key: 'k.after', value: 3 });
    });
  });

  describe('row-level security', () => {
    it("keeps tenant A's typed queries away from tenant B's rows", async () => {
      await db.withTenant(world.ngoB, (tx) =>
        typed(tx).insertInto('tenant_setting').values({ tenant_id: world.ngoB, key: 'k.secret', value: JSON.stringify('bodhi') }).execute(),
      );

      expect(await setting(world.ngoA, 'k.secret')).toBeUndefined();
      const read = await db.withTenant(world.ngoA, (tx) => typed(tx).selectFrom('tenant_setting').select('tenant_id').where('tenant_id', '=', world.ngoB).execute());
      expect(read).toEqual([]);

      const updated = await db.withTenant(world.ngoA, (tx) =>
        typed(tx).updateTable('tenant_setting').set({ value: JSON.stringify('taken') }).where('key', '=', 'k.secret').returning('key').execute(),
      );
      expect(updated).toEqual([]);

      await expect(
        db.withTenant(world.ngoA, (tx) => typed(tx).insertInto('tenant_setting').values({ tenant_id: world.ngoB, key: 'k.planted', value: '1' }).execute()),
      ).rejects.toThrow(/row-level security/);

      expect(await setting(world.ngoB, 'k.secret')).toEqual({ key: 'k.secret', value: 'bodhi' });
      expect(await setting(world.ngoB, 'k.planted')).toBeUndefined();
    });
  });

  describe('affected-row counts', () => {
    const label = (tenantId: string, key: string) =>
      db.withTenant(tenantId, (tx) => typed(tx).selectFrom('role').select('label').where('key', '=', key).executeTakeFirst());

    const counts = async (tx: SqlExecutor, tenantId: string, prefix: string) => {
      const k = typed(tx);
      const like = `${prefix}_%`;
      return {
        inserted: await k
          .insertInto('role')
          .values([1, 2, 3].map((n) => ({ tenant_id: tenantId, key: `${prefix}_${n}`, label: `Role ${n}` })))
          .executeTakeFirstOrThrow(),
        conflicted: await k
          .insertInto('role')
          .values({ tenant_id: tenantId, key: `${prefix}_1`, label: 'Again' })
          .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
          .executeTakeFirstOrThrow(),
        updated: await k.updateTable('role').set({ label: 'Renamed' }).where('key', 'like', like).executeTakeFirstOrThrow(),
        missed: await k.updateTable('role').set({ label: 'Renamed' }).where('key', '=', `${prefix}_none`).executeTakeFirstOrThrow(),
        deleted: await k.deleteFrom('role').where('key', '=', `${prefix}_3`).executeTakeFirstOrThrow(),
        selected: await sql`select 1`.execute(k),
      };
    };

    const expectCounts = (c: Awaited<ReturnType<typeof counts>>) => {
      expect(c.inserted.numInsertedOrUpdatedRows).toBe(3n);
      expect(c.conflicted.numInsertedOrUpdatedRows).toBe(0n);
      expect(c.updated.numUpdatedRows).toBe(3n);
      expect(c.missed.numUpdatedRows).toBe(0n);
      expect(c.deleted.numDeletedRows).toBe(1n);
      expect(c.selected.numAffectedRows).toBeUndefined();
    };

    it('counts inserted, updated and deleted rows through typed(tx) inside withTenant()', async () => {
      expectCounts(await db.withTenant(world.ngoA, (tx) => counts(tx, world.ngoA, 'count_tenant')));
      expect(await label(world.ngoA, 'count_tenant_1')).toEqual({ label: 'Renamed' });
      expect(await label(world.ngoA, 'count_tenant_3')).toBeUndefined();
    });

    it('counts through joinTransaction()', async () => {
      const c = await db.withTenant(world.ngoA, (tx) => joinTransaction(world.ngoA, tx).withTenant(world.ngoA, (t) => counts(t, world.ngoA, 'count_joined')));
      expectCounts(c);
    });

    it("counts only the tenant's rows under row-level security", async () => {
      const seed = (tenantId: string, keys: string[]) =>
        db.withTenant(tenantId, (tx) =>
          typed(tx)
            .insertInto('role')
            .values(keys.map((key) => ({ tenant_id: tenantId, key, label: key })))
            .execute(),
        );
      await seed(world.ngoA, ['count_rls_a1', 'count_rls_a2']);
      await seed(world.ngoB, ['count_rls_b1']);
      const update = (tx: SqlExecutor) => typed(tx).updateTable('role').set({ label: 'Shared' }).where('key', 'like', 'count_rls_%').executeTakeFirstOrThrow();

      expect((await db.withTenant(world.ngoA, update)).numUpdatedRows).toBe(2n);
      expect((await db.withTenant(world.ngoB, update)).numUpdatedRows).toBe(1n);
      expect((await db.asSystem(update)).numUpdatedRows).toBe(3n);
      const deleted = await db.withTenant(world.ngoB, (tx) => typed(tx).deleteFrom('role').where('key', 'like', 'count_rls_%').executeTakeFirstOrThrow());
      expect(deleted.numDeletedRows).toBe(1n);
      expect(await label(world.ngoA, 'count_rls_a1')).toEqual({ label: 'Shared' });
    });

    it('still returns rows for returning clauses', async () => {
      const rows = await db.withTenant(world.ngoA, async (tx) => {
        const k = typed(tx);
        const inserted = await k
          .insertInto('role')
          .values([
            { tenant_id: world.ngoA, key: 'count_ret_1', label: 'One' },
            { tenant_id: world.ngoA, key: 'count_ret_2', label: 'Two' },
          ])
          .returning('key')
          .execute();
        const updated = await k.updateTable('role').set({ label: 'Five' }).where('key', '=', 'count_ret_2').returning(['key', 'label']).execute();
        const deleted = await k.deleteFrom('role').where('key', 'like', 'count_ret_%').returning('key').execute();
        return { inserted, updated, deleted };
      });
      expect(rows.inserted.map((r) => r.key).sort()).toEqual(['count_ret_1', 'count_ret_2']);
      expect(rows.updated).toEqual([{ key: 'count_ret_2', label: 'Five' }]);
      expect(rows.deleted.map((r) => r.key).sort()).toEqual(['count_ret_1', 'count_ret_2']);
    });

    it('leaves raw query() returning rows only', async () => {
      const rows = await db.withTenant(world.ngoA, (tx) =>
        tx.query(`insert into tenant_setting (tenant_id, key, value) values (app_tenant(), 'k.count.raw', '1') returning key`),
      );
      expect(rows).toEqual([{ key: 'k.count.raw' }]);
    });
  });
});
