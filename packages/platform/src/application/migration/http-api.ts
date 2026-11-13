import type { MigrationService } from './migration-service.js';

/** Data migrations: their files, mappings, order and books, the check, the run and the failed rows. */
export interface MigrationsApi {
  migrations: MigrationService;
}
