import type { Database } from '../infrastructure/postgres/db.js';
import { DEFAULT_FY_START_MONTH, FY_START_SETTING, fiscalYearKey, numberingPeriod } from '../domain/ledger/fiscal-year.js';
import { transactions } from '../infrastructure/postgres/tx.js';
import { pgAuditTrail } from '../infrastructure/audit/audit-trail.js';
import { credentialCrypto, KeyRing, SecretKeys } from '@onengo/kernel/crypto';
import { IdempotencyStore } from '../infrastructure/http/idempotency.js';
import { JsonLogger } from '@onengo/kernel/observability';
import { PostgresIdempotencyKeyStore } from '../infrastructure/postgres/stores/idempotency-store.js';
import { PostgresSequenceStore } from '../infrastructure/postgres/stores/sequence-store.js';
import { ownerCapabilities } from '../infrastructure/postgres/tenant-directory.js';
import { SchemaRegistry } from '../runtime/definitions/schema-registry.js';
import { SensitiveFields } from '../runtime/records/sensitive.js';
import { ScriptSandbox, type ScriptWorkerEntry } from '../runtime/scripts/sandbox.js';
import type { PlatformOptions } from '../platform.js';
import { atPortBoundary } from './infrastructure-errors.js';

/** Where the product's files live; computed by platform.ts, which knows where the bundle sits. */
export interface Paths {
  migrations: string;
  modules: string;
  platform: string;
  schemas: string;
  locale: string;
  localFiles: string;
  web: string;
  /** The script worker thread: `dist/sandbox-worker.js` in the bundle, the TypeScript file under tsx from source. */
  sandboxWorker: ScriptWorkerEntry;
}

/** The sequence counters, with the financial-year rules the domain owns handed to the PostgreSQL store. */
export function wireSequences(): PostgresSequenceStore {
  return new PostgresSequenceStore({ settingKey: FY_START_SETTING, defaultStartMonth: DEFAULT_FY_START_MONTH, fiscalYearKey, numberingPeriod });
}

/** What every capability is wired from: the database, its owner-level capabilities, transactions, the audit trail, the sequence counters, the logger and the schemas. The audit trail (the PostgreSQL adapter) is handed to each service that writes audit or outbox events. */
export function wireInfrastructure(db: Database, options: PlatformOptions, paths: Paths) {
  const logger = options.logger ?? new JsonLogger();
  const schemas = new SchemaRegistry(paths.schemas);
  const owner = ownerCapabilities(db);
  const tm = transactions(db);
  return {
    db,
    options,
    paths,
    logger,
    schemas,
    owner,
    tm,
    audit: pgAuditTrail,
    sandbox: new ScriptSandbox(paths.schemas, paths.sandboxWorker),
    idempotency: atPortBoundary(new IdempotencyStore(new PostgresIdempotencyKeyStore(db))),
    sequences: wireSequences(),
  };
}
export type Base = ReturnType<typeof wireInfrastructure>;

/** The installation's keys and what is built from them: stored secrets, credential crypto, sensitive record values. */
export function wireCryptography(options: PlatformOptions) {
  const sensitive = new SensitiveFields(new KeyRing(options.encryptionKey, options.previousEncryptionKeys));
  const secretKeys = new SecretKeys(options.encryptionKey, options.previousEncryptionKeys);
  return { sensitive, secretKeys, crypto: credentialCrypto(secretKeys) };
}
export type Cryptography = ReturnType<typeof wireCryptography>;
