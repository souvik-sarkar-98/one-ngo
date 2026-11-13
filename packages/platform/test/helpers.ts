import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileLimits } from '../src/application/files/file-service.js';
import { LocalFileStore, type FileStore } from '@onengo/kernel/files';
import type { PaymentProvider } from '../src/infrastructure/payments/providers.js';
import type { ConnectorHttp } from '../src/infrastructure/connectors/http.js';
import { organisationToday } from '../src/shared/time/organisation-time.js';
import { MemoryTransport } from '@onengo/kernel/notify';
import pg from 'pg';
import { inject } from 'vitest';
import type { HttpFetch, OidcProviderConfig } from '../src/application/identity/oidc.js';
import type { Actor, Database, TenantContext } from '../src/infrastructure/postgres/db.js';
import type { Logger } from '@onengo/kernel/ports';
import { MemoryLogger } from '@onengo/kernel/observability';
import { PgDatabase } from '../src/infrastructure/postgres/pg-database.js';
import { provisionTenant } from '../src/infrastructure/postgres/tenants.js';
import { DEFAULT_SHIPPED_MODULES, prepareDeployment } from '../src/prepare-deployment.js';
import { createPlatform, type Platform } from '../src/platform.js';
import { asTx } from '../src/infrastructure/postgres/tx.js';

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
 * (`<DATABASE_URL name>_test`, set up by test/global-setup.ts) and drops it on close.
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

export async function createWorld(
  options: {
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
    fileStore?: FileStore;
    files?: FileLimits;
    exportInlineRows?: number;
    bulkInlineRecords?: number;
    bulkMaxRecords?: number;
    memoryAlertMb?: number;
    /** Set when a test starts a second platform that must accept this one's tokens. */
    tokenSecret?: string;
    /** Set when a test starts a second platform that must read this one's sensitive values. */
    encryptionKey?: Buffer;
  } = {},
): Promise<TestWorld> {
  const { db, dispose } = await openTestDatabase();
  const filesDir = options.fileStore ? null : mkdtempSync(join(tmpdir(), 'ngo-files-'));
  const mail = new MemoryTransport();
  const deployed = await prepareDeployment(db, { shippedModules: options.donations === false ? [] : DEFAULT_SHIPPED_MODULES });
  const platform = await createPlatform(db, {
    definitionCacheCheckMs: 0,
    tokenSecret: options.tokenSecret ?? randomBytes(32).toString('hex'),
    encryptionKey: options.encryptionKey ?? randomBytes(32),
    defaultEmailTransport: mail,
    paymentProviders: options.paymentProviders,
    logger: options.logger ?? new MemoryLogger(),
    publicBaseUrl: 'https://ngo.test',
    oidcProviders: options.oidcProviders,
    oidcFetch: options.oidcFetch,
    autoRunJobs: options.autoRunJobs,
    localeCatalogues: options.localeCatalogues,
    connectorHttp: options.connectorHttp ?? refuseConnectorHttp,
    fileStore: options.fileStore ?? new LocalFileStore(filesDir!),
    files: options.files,
    exportInlineRows: options.exportInlineRows,
    bulkInlineRecords: options.bulkInlineRecords,
    bulkMaxRecords: options.bulkMaxRecords,
    memoryAlertMb: options.memoryAlertMb,
  });
  const ngoA = await provisionTenant(db, { key: 'asha', name: 'Asha Trust', region: 'asia-south1' });
  const ngoB = await provisionTenant(db, { key: 'bodhi', name: 'Bodhi Society', region: 'asia-south1' });
  const as = (tenantId: string, actor: Actor = admin): TenantContext => ({ tenantId, actor });

  const donations = deployed.modules.find((m) => m.manifest.key === 'donations');
  if (donations) {
    for (const tenant of [ngoA, ngoB]) {
      await platform.definitions.enableModule(as(tenant), donations.manifest);
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
 * Gives a tenant the identity a receipt needs: a legal name and a registered
 * address. Receipts are refused until both are set, as they are printed on one.
 */
export async function completeIdentity(w: TestWorld, tenantId: string, legalName = 'Asha Foundation Trust'): Promise<void> {
  const ctx = w.as(tenantId);
  await w.platform.administration.saveSettings(ctx, { legalName });
  await w.platform.organisation.saveProfile(ctx, {
    address: { line1: '14 River Road', city: 'Pune', state: 'MH', postalCode: '411001', country: 'IN' },
  });
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
