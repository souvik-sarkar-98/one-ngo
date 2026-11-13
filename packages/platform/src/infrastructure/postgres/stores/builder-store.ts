import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { BuilderStore } from '../../../application/definitions/ports/builder-store.js';
import type { DB } from '../kysely.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { PostgresSequenceStore } from './sequence-store.js';
import { executorOf, pg } from '../tx.js';

const appTenant = sql<string>`app_tenant()`;

async function count(tx: Tx, typeKey: string, where: (eb: ExpressionBuilder<DB, 'record'>) => Expression<SqlBool>): Promise<number> {
  const row = await pg(tx)
    .selectFrom('record')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('tenant_id', '=', appTenant)
    .where('type_key', '=', typeKey)
    .where('deleted_at', 'is', null)
    .where(where)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

export class PgBuilderStore implements BuilderStore {
  constructor(private readonly sequences: PostgresSequenceStore) {}

  async nextNumber(tx: Tx, sequence: string, reset: 'fiscal_year' | 'never' | undefined) {
    const executor = executorOf(tx);
    const fy = this.sequences.rules.fiscalYearKey(new Date().toISOString().slice(0, 10), await this.sequences.fiscalYearStartMonth(executor));
    const period = this.sequences.rules.numberingPeriod(reset, fy);
    return { next: await this.sequences.peekSequenceValue(executor, `record:${sequence}`, period), fy, period };
  }

  countWithValue(tx: Tx, typeKey: string, field: string, present: boolean): Promise<number> {
    return count(tx, typeKey, (eb) => eb(sql`coalesce(data ->> ${field}, '')`, present ? '<>' : '=', ''));
  }

  countInPrimaryState(tx: Tx, typeKey: string, state: string, workflowKey: string, defaultPrimary: string): Promise<number> {
    return count(tx, typeKey, (eb) => eb.and([eb('status', '=', state), eb(sql`coalesce(workflow_key, ${defaultPrimary})`, '=', workflowKey)]));
  }

  countInParallelState(tx: Tx, typeKey: string, workflowKey: string, state: string): Promise<number> {
    return count(tx, typeKey, (eb) => eb(sql`workflow_state ->> ${workflowKey}`, '=', state));
  }

  async activeAccountCodes(tx: Tx): Promise<string[]> {
    const rows = await pg(tx).selectFrom('ledger_account').select('code').where('tenant_id', '=', appTenant).where('active', '=', true).execute();
    return rows.map((a) => a.code);
  }
}
