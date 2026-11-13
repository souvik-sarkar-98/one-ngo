import { sql, type RawBuilder, type SqlBool } from 'kysely';
import type { Database } from './db.js';
import { typed, type DB } from './kysely.js';

export interface RetentionPolicy {
  /** Processed background events. */
  outboxDoneDays?: number;
  outboxFailedDays?: number;
  automationRunDays?: number;
  scriptRunDays?: number;
  /**
   * Audit events older than this are archived and then deleted. Unset keeps
   * the audit log in the database forever.
   */
  auditDays?: number;
  /** Must durably store the rows before it resolves; deletion happens only after. */
  archiveAudit?: (tenantId: string, rows: Record<string, unknown>[]) => Promise<void>;
  batchSize?: number;
  /**
   * Whole years financial records are kept after their date; at least 1.
   * PENDING COUNSEL CONFIRMATION: defaults to FINANCIAL_RETENTION_YEARS_DEFAULT.
   */
  financialRetentionYears?: number;
}

export interface RetentionResult {
  deleted: Record<string, number>;
  auditArchived: number;
}

/**
 * PENDING COUNSEL CONFIRMATION. Eight years after their date, the common
 * Indian statutory practice for books of account; counsel has not confirmed
 * the period. Each installation can set its own (FINANCIAL_RETENTION_YEARS).
 */
export const FINANCIAL_RETENTION_YEARS_DEFAULT = 8;

/**
 * Financial records: journals, receipts and payments, and what they point at.
 * Retention never deletes them, and erasure keeps them; the database already
 * refuses to delete posted journals and issued receipts.
 */
export const FINANCIAL_TABLES = [
  'ledger_account',
  'fiscal_period',
  'journal_entry',
  'journal_line',
  'money_account',
  'transfer',
  'receipt_series',
  'receipt',
  'receipt_issuer',
  'receipt_content',
  'payment_intent',
  'payment_event',
] as const satisfies readonly (keyof DB)[];

/** The financial retention period in years this installation uses (pending counsel confirmation). */
export function financialRetentionYears(policy: Pick<RetentionPolicy, 'financialRetentionYears'> = {}): number {
  return days(policy.financialRetentionYears, FINANCIAL_RETENTION_YEARS_DEFAULT);
}

function days(value: number | undefined, fallback: number): number {
  const n = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** Removes data that has served its purpose, in bounded batches so a tick stays short. */
export async function applyRetention(db: Database, policy: RetentionPolicy = {}): Promise<RetentionResult> {
  const limit = days(policy.batchSize, 5000);
  const rules: [keyof DB, RawBuilder<SqlBool>][] = [
    ['outbox_event', sql`status = 'done' and processed_at < now() - make_interval(days => ${days(policy.outboxDoneDays, 7)})`],
    ['outbox_event', sql`status = 'failed' and created_at < now() - make_interval(days => ${days(policy.outboxFailedDays, 30)})`],
    ['automation_run', sql`done_at < now() - make_interval(days => ${days(policy.automationRunDays, 90)})`],
    ['script_run', sql`at < now() - make_interval(days => ${days(policy.scriptRunDays, 90)})`],
    ['email_code', sql`expires_at < now() - interval '1 day'`],
    ['password_token', sql`expires_at < now() - interval '7 days'`],
    ['oidc_login', sql`expires_at < now() - interval '1 day'`],
    ['connector_oauth_state', sql`expires_at < now() - interval '1 day'`],
    ['refresh_token', sql`expires_at < now() - interval '7 days'`],
    ['auth_throttle', sql`window_started_at < now() - interval '1 day' and (locked_until is null or locked_until < now())`],
    ['rate_limit', sql`window_started_at < now() - interval '1 day'`],
    ['idempotency_key', sql`created_at < now() - interval '24 hours'`],
  ];
  const financial = new Set<string>(FINANCIAL_TABLES);
  if (rules.some(([table]) => financial.has(table))) throw new Error('Retention never deletes financial records.');
  const deleted: Record<string, number> = {};
  for (const [table, where] of rules) {
    const result = await db.asSystem((tx) => {
      const k = typed(tx);
      const batch = k.selectFrom(table).select(sql`ctid`.as('ctid')).where(where).limit(limit);
      return k.deleteFrom(table).where(sql<SqlBool>`ctid = any(array(${batch}))`).executeTakeFirstOrThrow();
    });
    deleted[table] = (deleted[table] ?? 0) + Number(result.numDeletedRows);
  }

  let auditArchived = 0;
  if (policy.auditDays !== undefined && policy.archiveAudit) {
    const tenants = await db.asSystem((tx) => typed(tx).selectFrom('tenant').select('id').execute());
    for (const { id } of tenants) {
      const rows = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('audit_event')
          .selectAll()
          .where('tenant_id', '=', id)
          .where('at', '<', sql<Date>`now() - make_interval(days => ${policy.auditDays})`)
          .orderBy('id')
          .limit(limit)
          .execute(),
      );
      if (!rows.length) continue;
      await policy.archiveAudit(id, rows);
      const ids = rows.map((r) => r.id);
      await db.asSystem((tx) =>
        typed(tx)
          .deleteFrom('audit_event')
          .where('id', '=', sql<string>`any(${ids}::bigint[])`)
          .execute(),
      );
      auditArchived += rows.length;
    }
  }
  return { deleted, auditArchived };
}
