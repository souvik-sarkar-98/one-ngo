import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileLimits } from '../../../packages/platform/src/application/files/file-service.js';
import { LocalFileStore, type FileStore } from '@onengo/kernel/files';
import type { PaymentProvider } from '../../../packages/platform/src/infrastructure/payments/providers.js';
import type { ConnectorHttp } from '../../../packages/platform/src/infrastructure/connectors/http.js';
import { organisationToday } from '../../../packages/platform/src/shared/time/organisation-time.js';
import { MemoryTransport } from '@onengo/kernel/notify';
import pg from 'pg';
import { inject } from 'vitest';
import type { HttpFetch, OidcProviderConfig } from '../../../packages/platform/src/application/identity/oidc.js';
import type { Actor, Database, TenantContext } from '../../../packages/platform/src/infrastructure/postgres/db.js';
import type { Logger } from '@onengo/kernel/ports';
import { MemoryLogger } from '@onengo/kernel/observability';
import { PgDatabase } from '../../../packages/platform/src/infrastructure/postgres/pg-database.js';
import { provisionTenant } from '../../../packages/platform/src/infrastructure/postgres/tenants.js';
import { prepareDeployment } from '../../../packages/platform/src/prepare-deployment.js';
import { loadModulePackage, publishModulePackage } from '../../../packages/platform/src/runtime/definitions/package-loader.js';
import type { ModuleManifest } from '../../../packages/platform/src/runtime/definitions/types.js';
import { createPlatform, type Platform } from '../../../packages/platform/src/platform.js';
import { asTx } from '../../../packages/platform/src/infrastructure/postgres/tx.js';

export const admin: Actor = { id: 'admin-1', roles: ['admin'], permissions: ['*'] };
export const clerk: Actor = {
  id: 'clerk-1',
  roles: ['finance'],
  permissions: ['record:donation:create', 'record:donation:read', 'record:donation:update', 'record:donation:transition:*'],
};

const refuseConnectorHttp: ConnectorHttp = async (req) => {
  throw new Error(`Tests never call out: ${req.method} ${req.url}`);
};

export interface TestWorld {
  platform: Platform;
  ngoA: string;
  ngoB: string;
  mail: MemoryTransport;
  /** The local file store's folder, when the world made one. */
  filesDir: string | null;
  as(tenantId: string, actor?: Actor): TenantContext;
  close(): Promise<void>;
}

async function ownerQuery(url: string, sql: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

/**
 * Each world migrates its own throwaway schema of the test database
 * (`<DATABASE_URL name>_test`, set up by tests/support/platform/global-setup.ts) and drops it on close.
 */
export async function openTestDatabase(): Promise<{ db: Database; dispose: () => Promise<void> }> {
  const url = inject('testDatabaseUrl' as never) as string;
  const schema = `${inject('testSchemaPrefix' as never) as string}${randomBytes(5).toString('hex')}`;
  await ownerQuery(url, `create schema ${schema}`);
  const db = new PgDatabase({ connectionString: url, schema, maxConnections: 3 });
  return {
    db,
    dispose: async () => {
      await db.close();
      await ownerQuery(url, `drop schema ${schema} cascade`);
    },
  };
}

/** The test-owned donations module (see fixtures/donations-frozen). */
const TEST_DONATIONS_DIR = join(import.meta.dirname, 'fixtures', 'donations-frozen');

/** Publishes the test-owned donations module to the base layer and returns its manifest. */
async function publishTestDonations(platform: Platform): Promise<ModuleManifest> {
  const pkg = await loadModulePackage(TEST_DONATIONS_DIR, platform.schemas);
  await publishModulePackage(platform.definitions, pkg);
  return pkg.manifest;
}

export async function createWorld(
  options: {
    /** Default true: a test-owned copy of the donations module, so product changes do not reach these tests. false: none. */
    donations?: boolean;
    /** The year opened in both organisations with donations; null opens none. */
    fiscalYear?: string | null;
    paymentProviders?: PaymentProvider[];
    logger?: Logger;
    oidcProviders?: OidcProviderConfig[];
    oidcFetch?: HttpFetch;
    autoRunJobs?: boolean;
    localeCatalogues?: Record<string, unknown>;
    connectorHttp?: ConnectorHttp;
    /** `null` leaves the organisation with no store, as the product server does. */
    fileStore?: FileStore | null;
    /** Replaces outbound HTTP for storage connectors. */
    storageFetch?: typeof fetch;
    files?: FileLimits;
    exportInlineRows?: number;
    bulkInlineRecords?: number;
    bulkMaxRecords?: number;
    memoryAlertMb?: number;
    /** When false, no stand-in mail transport is installed, as on the product servers. */
    mail?: boolean;
    /** Set when a test starts a second platform that must accept this one's tokens. */
    tokenSecret?: string;
    /** Set when a test starts a second platform that must read this one's sensitive values. */
    encryptionKey?: Buffer;
  } = {},
): Promise<TestWorld> {
  const { db, dispose } = await openTestDatabase();
  const filesDir = options.fileStore !== undefined ? null : mkdtempSync(join(tmpdir(), 'ngo-files-'));
  const mail = new MemoryTransport();
  await prepareDeployment(db, { shippedModules: [] });
  const platform = await createPlatform(db, {
    definitionCacheCheckMs: 0,
    tokenSecret: options.tokenSecret ?? randomBytes(32).toString('hex'),
    encryptionKey: options.encryptionKey ?? randomBytes(32),
    defaultEmailTransport: options.mail === false ? undefined : mail,
    paymentProviders: options.paymentProviders,
    logger: options.logger ?? new MemoryLogger(),
    publicBaseUrl: 'https://ngo.test',
    oidcProviders: options.oidcProviders,
    oidcFetch: options.oidcFetch,
    autoRunJobs: options.autoRunJobs,
    localeCatalogues: options.localeCatalogues,
    connectorHttp: options.connectorHttp ?? refuseConnectorHttp,
    fileStore: options.fileStore === undefined ? new LocalFileStore(filesDir!) : (options.fileStore ?? undefined),
    storageFetch: options.storageFetch,
    files: options.files,
    exportInlineRows: options.exportInlineRows,
    bulkInlineRecords: options.bulkInlineRecords,
    bulkMaxRecords: options.bulkMaxRecords,
    memoryAlertMb: options.memoryAlertMb,
  });
  const donations = options.donations === false ? undefined : await publishTestDonations(platform);
  const ngoA = await provisionTenant(db, { key: 'asha', name: 'Asha Trust', region: 'asia-south1' });
  const ngoB = await provisionTenant(db, { key: 'bodhi', name: 'Bodhi Society', region: 'asia-south1' });
  const as = (tenantId: string, actor: Actor = admin): TenantContext => ({ tenantId, actor });

  if (donations) {
    for (const tenant of [ngoA, ngoB]) {
      await platform.definitions.enableModule(as(tenant), donations);
      const fy = options.fiscalYear === undefined ? currentFiscalYear() : options.fiscalYear;
      if (fy !== null) await db.withTenant(tenant, (tx) => platform.ledger.openFiscalYear(asTx(tx), admin, fy));
    }
  }
  const close = async () => {
    await dispose();
    if (filesDir) await rm(filesDir, { recursive: true, force: true });
  };
  return { platform, ngoA, ngoB, mail, filesDir, as, close };
}

/**
 * Gives a tenant what a receipt needs: a legal name and a registered address,
 * which are printed on it, and a signatory for each of its receipt rules, since
 * a rule with none issues no receipts. Receipts are refused until all are set.
 */
export async function completeIdentity(w: TestWorld, tenantId: string, legalName = 'Asha Foundation Trust'): Promise<void> {
  const ctx = w.as(tenantId);
  await w.platform.administration.saveSettings(ctx, { legalName });
  await w.platform.organisation.saveProfile(ctx, {
    address: { line1: '14 River Road', city: 'Pune', state: 'MH', postalCode: '411001', country: 'IN' },
  });
  await chooseReceiptSignatory(w, tenantId);
}

/** Adds a signatory and chooses them for every receipt rule the tenant has; nothing is added when it has no receipt rules. */
export async function chooseReceiptSignatory(w: TestWorld, tenantId: string, name = 'Meera Shah', designation = 'Treasurer'): Promise<string | undefined> {
  const rules = await w.platform.definitions.list(tenantId, 'receiptRule');
  if (!rules.length) return undefined;
  const ctx = w.as(tenantId);
  const id = (await w.platform.organisation.addSignatory(ctx, { name, designation })).signatories.at(-1)!.id;
  for (const rule of rules) await w.platform.organisation.setDocumentSignatories(ctx, `receipt:${rule.key}`, { signatories: [id] });
  return id;
}

export function currentFiscalYear(date = new Date()): string {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() + 1 >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const today = () => organisationToday();

export async function expectCode(promise: Promise<unknown>, code: string): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code !== code) throw new Error(`Expected error code '${code}' but got '${err.code}': ${err.message}`);
    return err;
  }
  throw new Error(`Expected error code '${code}' but the call succeeded`);
}
