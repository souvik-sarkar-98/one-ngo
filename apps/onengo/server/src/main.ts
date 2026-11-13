import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditArchiveFromEnvironment,
  connectorHttpFromEnvironment,
  createLogger,
  databaseFailureFields,
  encryptionKeysFromEnvironment,
  fileStoreFromEnvironment,
  installationOidcFromEnvironment,
  openServerDatabase,
  paymentProvidersFromEnvironment,
  smtpFromEnvironment,
  watchMemory,
  createPlatform,
  PATHS,
} from '@onengo/platform/main';
//import { installFixtureHostsIfConfigured } from './fixture-hosts.js';
import { trustProxyFromEnv } from './http/client-address.js';
import { buildServer } from './http/server.js';
import { shutdownOnSignals } from './http/lifecycle.js';

const MEMORY_CHECK_MS = 60_000;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

/** `CORS_ORIGINS`: comma-separated browser origins (`http://localhost:4200`). Empty means same-origin only. */
function corsOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const origins: string[] = [];
  for (const part of value.split(',')) {
    const raw = part.trim();
    if (!raw) continue;
    if (raw === '*') throw new Error('CORS_ORIGINS cannot be *. List each browser origin.');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`CORS_ORIGINS entry is not an origin: ${raw}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`CORS_ORIGINS entry must be http or https: ${raw}`);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error(`CORS_ORIGINS entry must be an origin only, with no path: ${raw}`);
    }
    origins.push(url.origin);
  }
  return origins;
}

// Only the API dev script sets INTEGRATION_FIXTURE_ORIGIN; deployments keep the real Cloud Storage and breached-password hosts.
// installFixtureHostsIfConfigured();

const smtp = smtpFromEnvironment(process.env, required);

const logger = createLogger();
process.on('unhandledRejection', (reason) => logger.log('CRITICAL', 'Unhandled promise rejection', {}, reason));

const memoryAlertMb = process.env.MEMORY_ALERT_MB ? Number(process.env.MEMORY_ALERT_MB) : undefined;

const db = await openServerDatabase(process.env).catch((error: unknown) => {
  logger.log('CRITICAL', 'Start-up failed', databaseFailureFields(error), error);
  process.exit(1);
});
const platform = await createPlatform(db, {
  tokenSecret: required('TOKEN_SECRET'),
  ...encryptionKeysFromEnvironment(process.env, required),
  defaultEmailTransport: smtp,
  connectorHttp: connectorHttpFromEnvironment(process.env),
  logger,
  memoryAlertMb,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8080}`,
  passkeyOrigins: process.env.PASSKEY_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean),
  passwords: {
    breachCheck: process.env.BREACHED_PASSWORD_CHECK === 'off' ? 'off' : 'online',
    commonPasswordsFile: process.env.COMMON_PASSWORDS_FILE,
  },
  oidcProviders: installationOidcFromEnvironment(process.env),
  retention: {
    ...auditArchiveFromEnvironment(process.env),
    // Pending counsel confirmation; unset uses FINANCIAL_RETENTION_YEARS_DEFAULT (8).
    financialRetentionYears: process.env.FINANCIAL_RETENTION_YEARS ? Number(process.env.FINANCIAL_RETENTION_YEARS) : undefined,
  },
  fileStore: fileStoreFromEnvironment(process.env, PATHS.localFiles),
  paymentProviders: paymentProvidersFromEnvironment(process.env),
  files: {
    maxUploadMb: process.env.FILE_MAX_UPLOAD_MB ? Number(process.env.FILE_MAX_UPLOAD_MB) : undefined,
    defaultQuotaMb: process.env.FILE_DEFAULT_QUOTA_MB ? Number(process.env.FILE_DEFAULT_QUOTA_MB) : undefined,
  },
  paths: PATHS,
}).catch(async (error: unknown) => {
  logger.log('CRITICAL', 'Start-up failed', {}, error);
  await db.close();
  process.exit(1);
});
const app = buildServer(platform.http, {
  tickSecret: process.env.TICK_SECRET,
  trustAppEngineCron: !!process.env.GAE_SERVICE,
  trustProxy: trustProxyFromEnv(process.env),
  corsOrigins: corsOrigins(process.env.CORS_ORIGINS),
  webRoot: process.env.WEB_ROOT ?? PATHS.web,
  guideRoot: process.env.GUIDE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'onengo-guide', 'web', 'dist', 'guide', 'browser'),
  schemaDir: PATHS.schemas,
});
const port = Number(process.env.PORT ?? 8080);
shutdownOnSignals(app, { dispatcher: platform.dispatcher, db: platform.db, logger: platform.logger });
// Cron ticks reach one instance and can be an hour apart, so each serving instance also checks itself.
watchMemory(logger, memoryAlertMb, MEMORY_CHECK_MS);
await app.listen({ port, host: '0.0.0.0' });
logger.log('INFO', 'listening', { port });
