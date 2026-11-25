import { join } from 'node:path';
import { transactions } from '../infrastructure/postgres/tx.js';
import { pgAuditTrail } from '../infrastructure/audit/audit-trail.js';
import { SecretKeys } from '@onengo/kernel/crypto';
import { reencryptStoredSecrets } from '../infrastructure/crypto/secret-rotation.js';
import type { Database } from '../infrastructure/postgres/db.js';
import { migrate, migrationStatus } from '../infrastructure/postgres/migrate.js';
import { assertNoIncompatibleNewerSchema, readSchemaCompatibility } from '../infrastructure/postgres/schema-compatibility.js';
import { PgDefinitionStore } from '../infrastructure/postgres/stores/definition-store.js';
import { ownerCapabilities } from '../infrastructure/postgres/tenant-directory.js';
import { DefinitionService } from '../runtime/definitions/definition-service.js';
import { loadModulePackage, publishModulePackage, type ModulePackage } from '../runtime/definitions/package-loader.js';
import { SchemaRegistry } from '../runtime/definitions/schema-registry.js';
import type { Paths } from './infrastructure.js';

export type { ModulePackage };

export interface DeploymentOptions {
  /** Folders under `modules/` to publish to the base layer. */
  shippedModules: string[];
}

export interface DeploymentResult {
  /** Migration files applied by this run. */
  migrations: string[];
  modules: ModulePackage[];
  /** Organisations whose retired module options could not be moved over (an open draft, say); tried again next run. */
  optionsKept: { tenantId: string; reason: string }[];
}

/**
 * The work of a new version that runs once against the database, before the
 * version starts: migrations, then the shipped modules. A second run finds
 * nothing to do and stores no new definition versions.
 */
export async function runDeploymentSteps(db: Database, options: DeploymentOptions, paths: Paths): Promise<DeploymentResult> {
  const before = await migrationStatus(db, paths.migrations);
  assertNoIncompatibleNewerSchema(await readSchemaCompatibility(db, before.unknown));
  const migrations = await migrate(db, paths.migrations, before.unknown);
  const schemas = new SchemaRegistry(paths.schemas);
  const owner = ownerCapabilities(db);
  const definitions = new DefinitionService(transactions(db), new PgDefinitionStore(), schemas, owner.definitionBase, pgAuditTrail);
  const modules: ModulePackage[] = [];
  for (const key of options.shippedModules) {
    const pkg = await loadModulePackage(join(paths.modules, key), schemas);
    await publishModulePackage(definitions, pkg);
    modules.push(pkg);
  }
  const optionsKept: DeploymentResult['optionsKept'] = [];
  const manifests = modules.map((m) => m.manifest);
  for (const tenantId of await owner.tenants.activeIds()) {
    try {
      await definitions.retireModuleOptions(tenantId, manifests);
    } catch (e) {
      optionsKept.push({ tenantId, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { migrations, modules, optionsKept };
}

/** Rewrites stored two-step, connector and gateway secrets under the current key. */
export function rewriteStoredSecrets(db: Database, keys: { encryptionKey: Buffer; previousEncryptionKeys?: Buffer[] }): Promise<{ twoStep: number; connectors: number }> {
  return reencryptStoredSecrets(db, new SecretKeys(keys.encryptionKey, keys.previousEncryptionKeys));
}
