/**
 * What a database provider can do, published by its driver (section 11.3 of
 * docs/architecture/ngo-backend-enhancement-plan.md). A profile may change how
 * a provider meets a rule, never whether it does: tenancy, receipt and ledger
 * rules hold on every provider.
 */
export interface DatabaseCapabilities {
  provider: 'postgres' | 'mysql';
  /** How the database itself keeps one organisation's rows from another; application filtering alone never counts. */
  tenantIsolation: 'rls' | 'database-per-tenant';
  jsonRecordQueries: 'native' | 'limited';
  concurrentIndexBuild: boolean;
  /** Workers claim jobs and events without waiting on rows another worker holds. */
  skipLocked: boolean;
  /** Journal balance is checked at commit, so an entry's lines may be written one by one. */
  deferrableFinancialConstraints: boolean;
}
