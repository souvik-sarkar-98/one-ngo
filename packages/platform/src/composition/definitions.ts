import type { Database } from '../infrastructure/postgres/db.js';
import { migrationStatus } from '../infrastructure/postgres/migrate.js';
import { assertSchemaCompatibility, readSchemaCompatibility, SCHEMA_LEVEL } from '../infrastructure/postgres/schema-compatibility.js';
import { PgBuilderStore } from '../infrastructure/postgres/stores/builder-store.js';
import { postgresAdministrationStore } from '../infrastructure/postgres/stores/administration-store.js';
import { PgDefinitionStore } from '../infrastructure/postgres/stores/definition-store.js';
import { PgLocaleStore } from '../infrastructure/postgres/stores/locale-store.js';
import { organisationName } from '../infrastructure/postgres/stores/organisation-name.js';
import { DefinitionService } from '../runtime/definitions/definition-service.js';
import { MessageCatalogue } from '../runtime/definitions/messages.js';
import { RuntimeService } from '../runtime/definitions/runtime.js';
import type { Base, Paths } from './infrastructure.js';

const RUN_DEPLOY_STEP =
  'Run the deploy step against this database first (npm run deploy:prepare runs dist/deploy.js; npm run deploy:prepare:dev runs the source), then start again.';

/**
 * What process start checks instead of doing it: every required migration is
 * applied. One read, no writes.
 */
export async function assertDeploymentPrepared(db: Database, paths: Paths): Promise<void> {
  const { pending, unknown } = await migrationStatus(db, paths.migrations);
  const compatibility = await readSchemaCompatibility(db, unknown);
  assertSchemaCompatibility('main', compatibility);
  const requiredPending = pending.filter((name) => Number(/^(\d+)_/.exec(name)?.[1] ?? 0) <= compatibility.level || compatibility.level >= SCHEMA_LEVEL);
  if (requiredPending.length) {
    throw new Error(`The database schema is not current: ${requiredPending.length} required migration(s) not applied (${requiredPending.join(', ')}). ${RUN_DEPLOY_STEP}`);
  }
}

/** Definitions and the checks that start-up makes on them: published definitions, the Builder's reads, screen text. */
export async function wireDefinitions(base: Base) {
  const { db, tm, owner, schemas, logger, options, paths } = base;
  const definitions = new DefinitionService(tm, new PgDefinitionStore(), schemas, owner.definitionBase, base.audit, { cacheCheckMs: options.definitionCacheCheckMs });
  await assertDeploymentPrepared(db, paths);
  if (!(await owner.catalog.hasTrigram())) logger.log('WARNING', 'pg_trgm is not available; record search will not use an index');
  return {
    definitions,
    builderStore: new PgBuilderStore(base.sequences),
    organisationName: organisationName(tm),
    runtime: new RuntimeService(
      tm,
      new PgLocaleStore(),
      definitions,
      options.localeCatalogues ? new MessageCatalogue(undefined, options.localeCatalogues) : new MessageCatalogue(paths.locale),
      postgresAdministrationStore(base.sequences),
    ),
  };
}
export type Definitions = Awaited<ReturnType<typeof wireDefinitions>>;
