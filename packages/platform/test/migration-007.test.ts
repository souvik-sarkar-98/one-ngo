import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_TABLES } from '../src/infrastructure/postgres/tenant-export.js';
import { clerk, createWorld, type TestWorld } from './helpers.js';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const NEW_TABLES = [
  'member_pin',
  'connector_delivery',
  'job',
  'job_item',
  'api_key',
  'idempotency_key',
  'file_object',
  'record_import',
  'record_share',
] as const;

/** One row per new table for the given organisation, inserted as the owner. */
async function seed(tenant: string): Promise<void> {
  const { record } = await w.platform.records.create(w.as(tenant, clerk), 'donation', { donorName: 'Seed', amount: 1 });
  await w.platform.db.asSystem(async (tx) => {
    const [user] = await tx.query<{ id: string }>(
      `insert into app_user (email, display_name) values ($1, 'Pin owner') returning id`,
      [`pin-${tenant}@example.org`],
    );
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [tenant, user!.id]);
    await tx.query(`insert into member_pin (tenant_id, user_id, label, list_view, address) values ($1, $2, 'Mine', 'donations', '/records/donation?chip=mine')`, [
      tenant,
      user!.id,
    ]);
    await tx.query(`insert into connector (tenant_id, key, type) values ($1, 'hook', 'webhook')`, [tenant]);
    await tx.query(`insert into connector_delivery (tenant_id, connector_key, event, record_id) values ($1, 'hook', 'record.created', $2)`, [tenant, record.id]);
    const [job] = await tx.query<{ id: string }>(`insert into job (tenant_id, kind, created_by) values ($1, 'import', 'admin-1') returning id`, [tenant]);
    await tx.query(`insert into job_item (tenant_id, job_id, seq, status) values ($1, $2, 1, 'done')`, [tenant, job!.id]);
    await tx.query(`insert into api_key (tenant_id, name, secret_hash, role_key, created_by) values ($1, 'Website', 'x', 'finance', 'admin-1')`, [tenant]);
    await tx.query(
      `insert into idempotency_key (tenant_id, actor_id, key, request_hash, status_code, response) values ($1, 'admin-1', 'k', 'h', 200, '{}')`,
      [tenant],
    );
    const [file] = await tx.query<{ id: string }>(
      `insert into file_object (tenant_id, name, mime, size, sha256, storage_key, created_by) values ($1, 'a.csv', 'text/csv', 3, 'h', 'k', 'admin-1') returning id`,
      [tenant],
    );
    await tx.query(`insert into record_import (tenant_id, type_key, file_id, file_name, created_by) values ($1, 'donation', $2, 'a.csv', 'admin-1')`, [
      tenant,
      file!.id,
    ]);
    await tx.query(
      `insert into record_share (tenant_id, record_id, principal_kind, principal, access, created_by) values ($1, $2, 'role', 'viewer', 'read', 'admin-1')`,
      [tenant, record.id],
    );
  });
}

describe('migration 007', () => {
  it('adds the record columns, the trigram search index, and the locale and role columns', async () => {
    const columns = await w.platform.db.asSystem((tx) =>
      tx.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
          where (table_name, column_name) in (('record', 'search_text'), ('record', 'workflow_key'), ('record', 'workflow_state'),
                ('role', 'customised'), ('tenant', 'default_locale'), ('tenant_member', 'locale'))
            and table_schema = current_schema()`,
      ),
    );
    expect(columns).toHaveLength(6);
    const [index] = await w.platform.db.asSystem((tx) => tx.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'record_search' and schemaname = current_schema()`));
    expect(index?.indexdef).toMatch(/gin_trgm_ops/);
    const { record } = await w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'Fresh', amount: 2 });
    const [row] = await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query<{ workflow_state: unknown; customised: boolean }>(
        `select r.workflow_state, (select bool_or(customised) from role) as customised from record r where id = $1`,
        [record.id],
      ),
    );
    expect(row).toEqual({ workflow_state: {}, customised: false });
  });

  it('keeps every new table private to its organisation', async () => {
    await seed(w.ngoA);
    for (const table of NEW_TABLES) {
      const count = (tenant: string) =>
        w.platform.db.withTenant(tenant, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from ${table}`)).then((r) => r[0]!.n);
      expect({ table, own: await count(w.ngoA), other: await count(w.ngoB) }).toEqual({ table, own: 1, other: 0 });
    }
    await expect(
      w.platform.db.withTenant(w.ngoA, (tx) =>
        tx.query(`insert into job (tenant_id, kind, created_by) values ($1, 'bulk', 'clerk-1')`, [w.ngoB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps the shared index bookkeeping away from the runtime role', async () => {
    await expect(w.platform.db.withTenant(w.ngoA, (tx) => tx.query(`select * from managed_index`))).rejects.toThrow(/permission denied/);
  });

  it('includes the new organisation tables in the export, without API key secrets', async () => {
    for (const t of NEW_TABLES.filter((t) => t !== 'idempotency_key')) expect(TENANT_TABLES).toContain(t);
    const lines: string[] = [];
    await w.platform.exportTenant(w.ngoA, (l) => void lines.push(l));
    const key = lines.map((l) => JSON.parse(l)).find((l) => l.table === 'api_key');
    expect(key.row.secret_hash).toBeNull();
  });
});
