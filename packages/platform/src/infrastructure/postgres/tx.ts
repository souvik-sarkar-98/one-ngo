import type { Database } from './db.js';
import { typed, type TypedDb } from './kysely.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import { asTx, executorOf } from '@onengo/kernel/db';
export { asTx, executorOf } from '@onengo/kernel/db';

/** Tenant-scoped transactions for core code, opened on `db`. */
export function transactions(db: Database): TransactionManager {
  return { withTenant: (tenantId, fn, options) => db.withTenant(tenantId, (tx) => fn(asTx(tx)), options) };
}

/** Typed Kysely queries inside the open transaction `tx`. */
export const pg = (tx: Tx): TypedDb => typed(executorOf(tx));
