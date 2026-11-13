export type { TransactionOptions, Tx } from '@onengo/kernel/ports';
import type { TransactionOptions, Tx } from '@onengo/kernel/ports';

/** Tenant-scoped transactions for core code. Owner-level work goes through the named capabilities in src/infrastructure/postgres/tenant-directory.ts. */
export interface TransactionManager {
  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T>;
}
