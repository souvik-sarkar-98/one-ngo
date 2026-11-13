import type { TransactionManager, TransactionOptions, Tx } from './ports/transaction.js';

/** Transactions that all join `tx`, already open for `tenantId`, so several services commit or roll back as one. */
export function joinTx(tenantId: string, tx: Tx): TransactionManager {
  return {
    async withTenant<T>(t: string, fn: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T> {
      if (t !== tenantId) throw new Error('A joined transaction belongs to one organisation.');
      if (options?.isolation || options?.readOnly) throw new Error('A joined transaction keeps the isolation it was opened with.');
      return fn(tx);
    },
  };
}
