import { MigrationService } from '../application/migration/migration-service.js';
import { PgMigrationStore } from '../infrastructure/postgres/stores/migration-store.js';
import { csvCodec } from '../infrastructure/transfer/csv.js';
import type { Definitions } from './definitions.js';
import type { Files } from './files.js';
import type { Base } from './infrastructure.js';
import { atPortBoundary } from './infrastructure-errors.js';
import type { Jobs } from './jobs.js';
import type { Finance, Records } from './records.js';

/** Data migration from CSV files of another system, run as a job; the books go through the ledger and receipts. */
export function wireMigration(base: Base, { definitions }: Definitions, { records }: Records, { ledger, receipts }: Finance, { jobs }: Jobs, { files }: Files) {
  return {
    migration: new MigrationService(base.tm, new PgMigrationStore(), definitions, records, files, jobs, atPortBoundary(csvCodec), ledger, receipts, base.audit),
  };
}
export type Migration = ReturnType<typeof wireMigration>;
