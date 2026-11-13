import type { Database, SqlExecutor, TransactionOptions } from './database.js';
export { assertUuid } from '@onengo/kernel/db';

export type { Database, MigratorTarget, SqlExecutor, SqlResult, TransactionOptions } from './database.js';
export type { Actor, TenantContext } from '../../domain/ports/tenant-context.js';

/**
 * The id prefix of platform-run actors. Infrastructure may not import domain values, so it keeps this
 * copy; test/infrastructure-parity.test.ts keeps it identical to the domain's.
 */
export const SYSTEM_ACTOR_PREFIX = 'system:';

/**
 * A Database whose tenant transactions all join one transaction that is
 * already open, so several services can work as one unit: everything commits
 * or nothing does.
 */
export function joinTransaction(tenantId: string, tx: SqlExecutor): Database {
  return {
    async withTenant<T>(t: string, fn: (tx: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T> {
      if (t !== tenantId) throw new Error('A joined transaction belongs to one organisation.');
      if (options?.isolation || options?.readOnly) throw new Error('A joined transaction keeps the isolation it was opened with.');
      return fn(tx);
    },
    asSystem: () => Promise.reject(new Error('A joined transaction cannot run owner statements.')),
    exec: () => Promise.reject(new Error('A joined transaction cannot run owner statements.')),
    close: async () => undefined,
    migratorTarget: () => {
      throw new Error('A joined transaction cannot migrate.');
    },
  };
}


/**
 * `$1` is the tenant id and `$2` the process's bind key. app_bind_tenant
 * (migration 026) seals `app.tenant_id`, so the runtime role cannot switch
 * organisation with set_config.
 */
export const TENANT_PREAMBLE = [
  'set local role app_runtime',
  'select app_bind_tenant($1, $2)',
] as const;
