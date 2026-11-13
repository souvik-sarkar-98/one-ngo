import { fileAuditArchiver, gcsAuditArchiver } from '../infrastructure/audit/audit-archive.js';
import { parseKey, parseKeys } from '@onengo/kernel/crypto';
import { GcsFileStore, gcsJsonClient, LocalFileStore, metadataServerToken } from '@onengo/kernel/files';
import { SmtpTransport } from '@onengo/kernel/notify';
import { checkMemory, JsonLogger } from '@onengo/kernel/observability';
import type { EmailTransport, FileStore, Logger } from '@onengo/kernel/ports';
import { connectSupportedDatabase, unsupportedFields } from '../infrastructure/postgres/database-support.js';
import type { Database } from '../infrastructure/postgres/db.js';
import { connectorAllowedHosts, fetchConnectorHttp, type ConnectorHttp } from '../infrastructure/connectors/http.js';
import { CASHFREE_HOSTS, CashfreeProvider, RAZORPAY_API_BASE, RazorpayProvider, type PaymentProvider } from '../infrastructure/payments/providers.js';
import { PgDatabase } from '../infrastructure/postgres/pg-database.js';
import type { RetentionPolicy } from '../infrastructure/postgres/retention.js';
import type { OidcProviderConfig } from '../application/identity/oidc.js';
import type { Environment } from '@onengo/kernel/env';
export type { Environment } from '@onengo/kernel/env';

/**
 * What the process entry points (main, deploy, organisation) need that belongs to the installation:
 * its logger, database, mail, keys and file store, read from the environment. The entry points
 * import these instead of the adapters.
 */
export type { Database, Logger, EmailTransport, FileStore };

export const createLogger = (): Logger => new JsonLogger();

/** The fields of a start-up database failure that are safe to log. */
export const databaseFailureFields = (error: unknown) => unsupportedFields(error);

function targetEnvironment(env: Environment, connectionString: string): NodeJS.ProcessEnv {
  return { ...env, DATABASE_URL: connectionString };
}

function requiredDatabaseUrl(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} to a PostgreSQL connection string.`);
  return value;
}

/** The server's PostgreSQL pool. */
export function openServerDatabase(env: Environment): Promise<Database> {
  const connectionString = requiredDatabaseUrl(env, 'DATABASE_SYSTEM_URL');
  const runtimeConnectionString = requiredDatabaseUrl(env, 'DATABASE_RUNTIME_URL');
  return connectSupportedDatabase(targetEnvironment(env, connectionString), (url) =>
    PgDatabase.connect({ connectionString: url, runtimeConnectionString, maxConnections: Number(env.DATABASE_POOL_SIZE ?? 3) }),
  ).then(({ db }) => db);
}

/** `CONNECTOR_ALLOWED_HOSTS`: the connector transport, refusing non-public addresses except for the listed hosts. */
export function connectorHttpFromEnvironment(env: Environment): ConnectorHttp {
  return fetchConnectorHttp({ allowedHosts: connectorAllowedHosts(env.CONNECTOR_ALLOWED_HOSTS) });
}

function httpsBase(env: Environment, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not an address: ${raw}`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must be an https:// address.`);
  return raw;
}

/**
 * The payment gateways. `RAZORPAY_API_BASE` replaces `https://api.razorpay.com`; `CASHFREE_API_BASE`, when set,
 * replaces both the Cashfree sandbox and production hosts. Unset keeps the real hosts.
 */
export function paymentProvidersFromEnvironment(env: Environment): PaymentProvider[] {
  const razorpay = httpsBase(env, 'RAZORPAY_API_BASE') ?? RAZORPAY_API_BASE;
  const cashfree = httpsBase(env, 'CASHFREE_API_BASE');
  return [
    new RazorpayProvider(undefined, razorpay),
    new CashfreeProvider(undefined, undefined, cashfree ? { sandbox: cashfree, production: cashfree } : CASHFREE_HOSTS),
  ];
}

/** The deploy step's database, after the supported-version check. */
export async function openDeployDatabase(env: Environment): Promise<Database> {
  const connectionString = requiredDatabaseUrl(env, 'DATABASE_OWNER_URL');
  return (await connectSupportedDatabase(targetEnvironment(env, connectionString), (url) => PgDatabase.connect({ connectionString: url, maxConnections: 2 }))).db;
}

/** The operator control-plane database. */
export function openOperatorDatabase(env: Environment = process.env): Promise<Database> {
  const connectionString = requiredDatabaseUrl(env, 'OPERATOR_DATABASE_URL');
  const runtimeConnectionString = requiredDatabaseUrl(env, 'OPERATOR_RUNTIME_URL');
  return connectSupportedDatabase(targetEnvironment(env, connectionString), (url) =>
    PgDatabase.connect({ connectionString: url, runtimeConnectionString, maxConnections: 2 }),
  ).then(({ db }) => db);
}

/** `SMTP_*`: the installation's mail transport; none when `SMTP_HOST` is not set. */
export function smtpFromEnvironment(env: Environment, required: (name: string) => string): EmailTransport | undefined {
  return env.SMTP_HOST
    ? new SmtpTransport({
        host: env.SMTP_HOST,
        port: Number(env.SMTP_PORT ?? 587),
        secure: env.SMTP_SECURE === '1',
        user: required('SMTP_USER'),
        password: required('SMTP_PASSWORD'),
        from: required('SMTP_FROM'),
      })
    : undefined;
}

const GOOGLE_ISSUER = 'https://accounts.google.com';

/**
 * `OIDC_*`: the sign-in provider every NGO on this installation may opt into; none when `OIDC_CLIENT_ID` is
 * not set. Any OpenID Connect issuer works; Google is the default. Each `OIDC_*` name falls back to the older
 * `GOOGLE_*` one, and the provider id stays `google` for the Google issuer so existing opt-ins keep working.
 */
export function installationOidcFromEnvironment(env: Environment): OidcProviderConfig[] {
  const clientSecret = oidcSetting(env, 'CLIENT_SECRET');
  return installationOidcSummaryFromEnvironment(env).map(({ allowedDomains, ...provider }) => {
    if (!clientSecret) throw new Error('Set OIDC_CLIENT_SECRET.');
    return { ...provider, clientSecret, ...(allowedDomains.length ? { allowedDomains } : {}) };
  });
}

/**
 * The shared provider without its secret, for the operator console, which shows and configures each NGO's
 * opt-in but never signs anyone in. It reads the same `OIDC_*` (or `GOOGLE_*`) settings as the main server.
 */
export function installationOidcSummaryFromEnvironment(env: Environment): { id: string; label: string; issuer: string; clientId: string; allowedDomains: string[] }[] {
  const clientId = oidcSetting(env, 'CLIENT_ID');
  if (!clientId) return [];
  const issuer = oidcSetting(env, 'ISSUER') ?? GOOGLE_ISSUER;
  const legacyGoogle = !env.OIDC_ISSUER?.trim() && !env.OIDC_CLIENT_ID?.trim();
  const google = legacyGoogle || issuer === GOOGLE_ISSUER;
  const id = env.OIDC_PROVIDER_ID?.trim() || (google ? 'google' : 'sso');
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) throw new Error('OIDC_PROVIDER_ID must be lowercase letters, digits, or -.');
  const allowedDomains = oidcSetting(env, 'ALLOWED_DOMAINS')?.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) ?? [];
  return [{ id, label: env.OIDC_PROVIDER_LABEL?.trim() || (google ? 'Google' : 'Single sign-on'), issuer, clientId, allowedDomains }];
}

const oidcSetting = (env: Environment, name: string) => env[`OIDC_${name}`]?.trim() || env[`GOOGLE_${name}`]?.trim() || undefined;

/** `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS`. */
export function encryptionKeysFromEnvironment(env: Environment, required: (name: string) => string): { encryptionKey: Buffer; previousEncryptionKeys: Buffer[] | undefined } {
  return { encryptionKey: parseKey(required('ENCRYPTION_KEY')), previousEncryptionKeys: parseKeys(env.ENCRYPTION_KEY_PREVIOUS) };
}

/** Days audit rows stay in the database before they are archived, when `AUDIT_RETENTION_DAYS` is not set. */
export const AUDIT_RETENTION_DAYS_DEFAULT = 548; // one and a half years

/**
 * Audit rows older than `AUDIT_RETENTION_DAYS` (default 548, one and a half years) are archived before they are
 * deleted: to the Cloud Storage bucket `AUDIT_ARCHIVE_BUCKET` (under `AUDIT_ARCHIVE_PREFIX`, default
 * `audit-archive/`), else to the folder `AUDIT_ARCHIVE_DIR`. With neither set nothing is archived or deleted, so
 * the audit log is never lost by default. The bucket is used on App Engine, whose local disk does not persist.
 */
export function auditArchiveFromEnvironment(
  env: Environment,
  accessToken: () => Promise<string> = metadataServerToken(),
): Pick<RetentionPolicy, 'auditDays' | 'archiveAudit'> {
  const bucket = env.AUDIT_ARCHIVE_BUCKET?.trim();
  const dir = env.AUDIT_ARCHIVE_DIR?.trim();
  if (!bucket && !dir) return {};
  const raw = env.AUDIT_RETENTION_DAYS?.trim();
  const auditDays = raw ? Number(raw) : AUDIT_RETENTION_DAYS_DEFAULT;
  if (!Number.isInteger(auditDays) || auditDays < 1) {
    throw new Error(`AUDIT_RETENTION_DAYS must be a whole number of days, at least 1 (got '${raw}').`);
  }
  const archiveAudit = bucket
    ? gcsAuditArchiver(gcsJsonClient({ bucket, accessToken }), env.AUDIT_ARCHIVE_PREFIX ?? 'audit-archive/')
    : fileAuditArchiver(dir!);
  return { auditDays, archiveAudit };
}

/** Cloud Storage when `FILE_STORE_BUCKET` is set, a local folder otherwise. */
export function fileStoreFromEnvironment(env: Environment, defaultLocalDir: string): FileStore {
  return env.FILE_STORE_BUCKET
    ? new GcsFileStore(gcsJsonClient({ bucket: env.FILE_STORE_BUCKET, accessToken: metadataServerToken() }), env.FILE_STORE_PREFIX ?? '')
    : new LocalFileStore(env.FILE_STORE_DIR ?? defaultLocalDir);
}

/** Each serving instance checks its own memory; cron ticks reach one instance and can be an hour apart. */
export function watchMemory(logger: Logger, memoryAlertMb: number | undefined, everyMs: number): void {
  setInterval(() => checkMemory(logger, memoryAlertMb), everyMs).unref();
}
