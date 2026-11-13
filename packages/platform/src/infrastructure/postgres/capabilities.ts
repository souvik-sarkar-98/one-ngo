import type { DatabaseCapabilities } from '../../domain/ports/database-capabilities.js';

/** PostgreSQL 15 or later, as migrations/ set it up. */
export const postgresCapabilities: DatabaseCapabilities = {
  provider: 'postgres',
  tenantIsolation: 'rls',
  jsonRecordQueries: 'native',
  concurrentIndexBuild: true,
  skipLocked: true,
  deferrableFinancialConstraints: true,
};
