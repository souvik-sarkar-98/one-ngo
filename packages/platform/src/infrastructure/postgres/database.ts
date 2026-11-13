import type { TransactionOptions } from '../../domain/ports/transaction.js';
import type { MigratorTarget, SqlExecutor } from '@onengo/kernel/db';

export type { TransactionOptions } from '../../domain/ports/transaction.js';
export type { MigratorTarget, SqlExecutor, SqlResult } from '@onengo/kernel/db';

export interface Database {
  /**
   * Runs `fn` in one transaction as the runtime role with `app.tenant_id` set,
   * so row-level security limits every statement to that tenant.
   */
  withTenant<T>(tenantId: string, fn: (tx: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** Owner-level transaction for migrations, provisioning, and base definitions. */
  asSystem<T>(fn: (tx: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /** Connection settings for Kysely's migrator. A joined transaction cannot migrate. */
  migratorTarget(): MigratorTarget;
}
