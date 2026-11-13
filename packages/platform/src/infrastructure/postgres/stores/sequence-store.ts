import { sql } from 'kysely';
import type { SqlExecutor } from '../db.js';
import { typed } from '../kysely.js';

/**
 * The financial-year rules the stores need. The domain owns them (domain/ledger/fiscal-year.ts); infrastructure
 * may not import domain values, so composition passes them in.
 */
export interface FiscalYearRules {
  /** The organisation setting that holds the financial year start month. */
  settingKey: string;
  /** The start month when the organisation has not chosen one. */
  defaultStartMonth: number;
  /** Financial year label for a date. */
  fiscalYearKey(isoDate: string, startMonth?: number): string;
  /** The counter period of a numbering: one per financial year, or one for all time. */
  numberingPeriod(reset: 'fiscal_year' | 'never' | undefined, fy: string): string;
}

/** Gap-free counters per tenant, key and period, and the financial-year start month they depend on. */
export class PostgresSequenceStore {
  constructor(readonly rules: FiscalYearRules) {}

  /**
   * Gap-free counter per tenant, key, and period. The row lock is held until the
   * caller's transaction ends, so a rolled-back save never consumes a number.
   */
  async nextSequenceValue(tx: SqlExecutor, key: string, period: string): Promise<number> {
    const row = await typed(tx)
      .insertInto('sequence_counter')
      .values({ tenant_id: sql<string>`app_tenant()`, key, period, next_value: 2 })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'key', 'period']).doUpdateSet((eb) => ({ next_value: eb('sequence_counter.next_value', '+', eb.lit(1)) })),
      )
      .returning(sql<string>`(next_value - 1)::text`.as('value'))
      .executeTakeFirst();
    return Number(row!.value);
  }

  /**
   * Makes the next value for this key and period at least `next`, never lower, and returns
   * the value the next call will take.
   */
  async raiseSequenceValue(tx: SqlExecutor, key: string, period: string, next: number): Promise<number> {
    const row = await typed(tx)
      .insertInto('sequence_counter')
      .values({ tenant_id: sql<string>`app_tenant()`, key, period, next_value: next })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'key', 'period']).doUpdateSet({ next_value: sql<number>`greatest(sequence_counter.next_value, excluded.next_value)` }),
      )
      .returning(sql<string>`next_value::text`.as('value'))
      .executeTakeFirst();
    return Number(row!.value);
  }

  /** The value the next call for this key and period returns, without taking it. */
  async peekSequenceValue(tx: SqlExecutor, key: string, period: string): Promise<number> {
    const row = await typed(tx)
      .selectFrom('sequence_counter')
      .select(sql<string>`next_value::text`.as('value'))
      .where('tenant_id', '=', sql<string>`app_tenant()`)
      .where('key', '=', key)
      .where('period', '=', period)
      .executeTakeFirst();
    return row ? Number(row.value) : 1;
  }

  /** The organisation's financial year start month (1 to 12), read in the caller's transaction. */
  async fiscalYearStartMonth(tx: SqlExecutor): Promise<number> {
    const row = await typed(tx)
      .selectFrom('tenant_setting')
      .select('value')
      .where('tenant_id', '=', sql<string>`app_tenant()`)
      .where('key', '=', this.rules.settingKey)
      .executeTakeFirst();
    const month = Number(row?.value);
    return Number.isInteger(month) && month >= 1 && month <= 12 ? month : this.rules.defaultStartMonth;
  }

  /**
   * Holds the start month steady until the transaction ends: shared by everything
   * that fixes it (opening a period, issuing a receipt), exclusive while changing it.
   */
  async holdFiscalYearStart(tx: SqlExecutor, mode: 'shared' | 'exclusive'): Promise<void> {
    const fn = mode === 'shared' ? sql.raw('pg_advisory_xact_lock_shared') : sql.raw('pg_advisory_xact_lock');
    await sql`select ${fn}(hashtext(${this.rules.settingKey}), hashtext(app_tenant()::text))`.execute(typed(tx));
  }
}
