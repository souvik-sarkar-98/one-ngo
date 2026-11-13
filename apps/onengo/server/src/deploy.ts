import {
  DEFAULT_SHIPPED_MODULES,
  PATHS,
  createLogger,
  databaseFailureFields,
  deployStepOptions,
  encryptionKeysFromEnvironment,
  openDeployDatabase,
  prepareDeployment,
  queueSensitiveFieldReencryption,
  type Database,
  type DeployStepOptions,
} from '@onengo/platform/deployment';

/** `SHIPPED_MODULES`: comma-separated folders under `modules/`. Unset means donations; empty means none. */
function shippedModules(value: string | undefined): string[] {
  if (value === undefined) return DEFAULT_SHIPPED_MODULES;
  return value.split(',').map((key) => key.trim()).filter(Boolean);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

const logger = createLogger();
let options: DeployStepOptions;
let db: Database;
try {
  options = deployStepOptions(process.argv.slice(2));
  db = await openDeployDatabase(process.env);
} catch (error) {
  logger.log('CRITICAL', 'Start-up failed', databaseFailureFields(error), error);
  process.exit(1);
}
try {
  const result = await prepareDeployment(db, { shippedModules: shippedModules(process.env.SHIPPED_MODULES), paths: PATHS });
  logger.log('INFO', 'deployment prepared', {
    migrations: result.migrations.join(', ') || 'none',
    modules: result.modules.map((m) => `${m.manifest.key}@${m.manifest.version}`).join(', ') || 'none',
  });
  if (options.reencryptSensitiveFields) {
    const queued = await queueSensitiveFieldReencryption(db, encryptionKeysFromEnvironment(process.env, required), logger, PATHS);
    logger.log('INFO', 'sensitive field re-encryption queued', { ...queued });
  }
} catch (error) {
  logger.log('CRITICAL', 'Preparing the deployment failed', {}, error);
  process.exitCode = 1;
} finally {
  await db.close();
}
