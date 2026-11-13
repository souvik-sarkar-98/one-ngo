import { sql } from 'kysely';
import type { OrganisationName } from '../../../domain/ports/organisation-name.js';
import type { TransactionManager } from '../../../domain/ports/transaction.js';
import { pg } from '../tx.js';

export function organisationName(tm: TransactionManager): OrganisationName {
  return async (tenantId) => {
    const tenant = await tm.withTenant(tenantId, (tx) => pg(tx).selectFrom('tenant').select('name').where('id', '=', sql<string>`app_tenant()`).executeTakeFirst());
    return tenant?.name;
  };
}
