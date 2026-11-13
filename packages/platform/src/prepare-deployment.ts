import { randomBytes } from 'node:crypto';
import { rewriteStoredSecrets, runDeploymentSteps, type DeploymentResult } from './composition/deployment.js';
import type { Database, Logger } from './composition/entry.js';
import { createPlatform, PATHS } from './platform.js';
import type { Paths } from './composition/infrastructure.js';

export const DEFAULT_SHIPPED_MODULES = ['donations'];

export interface DeploymentOptions {
  /** Folders under `modules/` to publish to the base layer. Default `donations`. */
  shippedModules?: string[];
  /** Explicit product assets used by deployment. */
  paths?: Paths;
}

export type { DeploymentResult };

/**
 * The work of a new version that runs once against the database, before the
 * version starts: migrations and the shipped modules. A second run finds
 * nothing to do and stores no new definition versions.
 */
export function prepareDeployment(db: Database, options: DeploymentOptions = {}): Promise<DeploymentResult> {
  return runDeploymentSteps(db, { shippedModules: options.shippedModules ?? DEFAULT_SHIPPED_MODULES }, options.paths ?? PATHS);
}

export const REENCRYPT_OPTION = '--reencrypt-sensitive-fields';

export interface DeployStepOptions {
  /** Also queue the one-time re-encryption of stored sensitive values. */
  reencryptSensitiveFields: boolean;
}

/** Command-line options of the deploy step; an unknown option is refused, so a typo never deploys silently. */
export function deployStepOptions(argv: readonly string[]): DeployStepOptions {
  const unknown = argv.filter((a) => a !== REENCRYPT_OPTION);
  if (unknown.length) throw new Error(`Unknown deploy step option: ${unknown.join(' ')}. The only option is ${REENCRYPT_OPTION}.`);
  return { reencryptSensitiveFields: argv.includes(REENCRYPT_OPTION) };
}

export interface ReencryptionKeys {
  encryptionKey: Buffer;
  previousEncryptionKeys?: Buffer[];
}

export interface ReencryptionQueued {
  organisations: number;
  recordTypes: number;
  /** Stored secrets rewritten under the current key by this run. */
  twoStepSecrets: number;
  connectorSecrets: number;
}

/**
 * Rewrites stored secrets (two-step, connector and gateway credentials) under
 * the current key, then queues a fields.reencrypt job for every record type
 * with stored sensitive values, on a prepared database. The serving instances
 * run the jobs on their ticks; this process only queues them. A job already
 * queued for a type is not queued again.
 */
export async function queueSensitiveFieldReencryption(db: Database, keys: ReencryptionKeys, logger: Logger, paths: Paths = PATHS): Promise<ReencryptionQueued> {
  const platform = await createPlatform(db, {
    // Nothing here signs access tokens.
    tokenSecret: randomBytes(32).toString('hex'),
    ...keys,
    logger,
    autoRunJobs: false,
    paths,
  });
  const secrets = await rewriteStoredSecrets(db, keys);
  const jobs = await platform.reencryptSensitiveFields();
  return {
    organisations: new Set(jobs.map((j) => j.tenantId)).size,
    recordTypes: jobs.length,
    twoStepSecrets: secrets.twoStep,
    connectorSecrets: secrets.connectors,
  };
}
