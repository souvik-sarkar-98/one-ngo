import { sql } from 'kysely';
import type { Database } from './db.js';
import { typed, type DB } from './kysely.js';

/** Tables holding one NGO's data, in an order that respects foreign keys on re-import. */
export const TENANT_TABLES = [
  'tenant_module',
  'definition',
  'extension_patch',
  'role',
  'tenant_member',
  'role_assignment',
  'tenant_setting',
  'organisation_profile',
  'organisation_registration',
  'record',
  'record_link',
  'sequence_counter',
  'ledger_account',
  'fiscal_period',
  'journal_entry',
  'journal_line',
  'money_account',
  'transfer',
  'receipt_series',
  'receipt',
  'payment_intent',
  'payment_event',
  'approval_request',
  'approval_decision',
  'notification',
  'automation_state',
  'connector',
  'connector_delivery',
  'member_pin',
  'api_key',
  'job',
  'job_item',
  'file_object',
  'tenant_asset',
  'receipt_issuer',
  'receipt_content',
  'receipt_link',
  'record_import',
  'migration_profile',
  'migration_source',
  'migration_key',
  'record_share',
  'consent_event',
  'erasure_request',
  'audit_event',
] as const satisfies readonly (keyof DB)[];

export interface ExportSummary {
  tenant: { id: string; key: string; name: string };
  counts: Record<string, number>;
}

/**
 * Writes every row the NGO owns as JSON lines: `{"table": "...", "row": {...}}`.
 * Runs in one repeatable-read transaction, so the export is a consistent
 * snapshot. Password hashes, two-step secrets, connector secrets, and API key
 * hashes are never exported.
 */
export async function exportTenant(
  db: Database,
  tenantId: string,
  writeLine: (line: string) => void | Promise<void>,
  pageSize = 1000,
): Promise<ExportSummary> {
  return db.asSystem(async (tx) => {
    const k = typed(tx);
    const tenant = await k.selectFrom('tenant').select(['id', 'key', 'name', 'legal_name', 'region']).where('id', '=', tenantId).executeTakeFirst();
    if (!tenant) throw new Error('Unknown organisation.');
    await writeLine(JSON.stringify({ table: 'tenant', row: tenant, format: 'ngo-platform-export/1', exportedAt: new Date().toISOString() }));

    const counts: Record<string, number> = {};
    const people = await k
      .selectFrom('app_user as u')
      .innerJoin('tenant_member as m', 'm.user_id', 'u.id')
      .select((eb) => ['u.id', 'u.email', eb.fn.coalesce('m.display_name', 'u.display_name').as('display_name'), 'u.status', 'u.created_at'])
      .where('m.tenant_id', '=', tenantId)
      .orderBy('u.id')
      .execute();
    for (const row of people) await writeLine(JSON.stringify({ table: 'app_user', row }));
    counts.app_user = people.length;

    for (const table of TENANT_TABLES) {
      counts[table] = 0;
      for (let offset = 0; ; offset += pageSize) {
        const rows: Record<string, unknown>[] = await k
          .selectFrom(table)
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .orderBy(sql`ctid`)
          .limit(pageSize)
          .offset(offset)
          .execute();
        for (const row of rows) {
          if (table === 'connector') row.secret_enc = null;
          if (table === 'api_key') row.secret_hash = null;
          await writeLine(JSON.stringify({ table, row }));
        }
        counts[table] += rows.length;
        if (rows.length < pageSize) break;
      }
    }
    return { tenant: { id: tenant.id, key: tenant.key, name: tenant.name }, counts };
  }, { isolation: 'repeatable read', readOnly: true });
}
