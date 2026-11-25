import { MigrationService } from '../application/migration/migration-service.js';
import { postgresRoleStore } from '../infrastructure/postgres/stores/role-store.js';
import { PgMigrationStore } from '../infrastructure/postgres/stores/migration-store.js';
import { csvCodec } from '../infrastructure/transfer/csv.js';
import type { Definitions } from './definitions.js';
import type { Files } from './files.js';
import type { Base } from './infrastructure.js';
import { atPortBoundary } from './infrastructure-errors.js';
import type { Identity } from './identity.js';
import type { Jobs } from './jobs.js';
import type { Finance, Records } from './records.js';

/** Data migration from CSV files of another system, run as a job; the books go through the ledger and receipts. People files add members through the identity service. */
export function wireMigration(base: Base, { definitions }: Definitions, { records }: Records, { ledger, receipts }: Finance, { jobs }: Jobs, { files }: Files, { identity }: Identity) {
  return {
    migration: new MigrationService(base.tm, new PgMigrationStore(), definitions, records, files, jobs, atPortBoundary(csvCodec), ledger, receipts, base.audit, base.owner.retention, identity, base.owner.members, postgresRoleStore),
  };
}
export type Migration = ReturnType<typeof wireMigration>;
