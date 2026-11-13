import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdministrationService } from './application/administration/administration-service.js';
import type { ActionService } from './application/actions/action-service.js';
import type { ReceiptPrintService } from './application/actions/receipt-print.js';
import type { BuilderSupport } from './application/definitions/builder-support.js';
import type { ConnectorService } from './application/connectors/connector-service.js';
import type { ConnectorHttp } from './application/connectors/ports/connector-runtime.js';
import type { FileLimits, FileService } from './application/files/file-service.js';
import type { AccessService } from './application/identity/access-service.js';
import type { ApiKeyService } from './application/identity/api-key-service.js';
import type { IdentityService } from './application/identity/identity-service.js';
import type { HttpFetch, OidcProviderConfig, OidcService } from './application/identity/oidc.js';
import type { PasskeyService } from './application/identity/passkey-service.js';
import type { PeopleService } from './application/identity/people-service.js';
import type { PinService } from './application/identity/pin-service.js';
import type { ProfileService } from './application/identity/profile-service.js';
import type { RolesService } from './application/identity/roles-service.js';
import type { HttpDeps } from './application/internal/http-api.js';
import type { NotificationService } from './application/notifications/notification-service.js';
import type { OrganisationService } from './application/organisations/organisation-service.js';
import type { PrivacyService } from './application/privacy/privacy-service.js';
import type { BulkService } from './application/records/bulk-service.js';
import type { ExportService } from './application/records/export-service.js';
import type { ImportService } from './application/records/import-service.js';
import type { RecordSharing } from './application/records/record-sharing.js';
import type { MoneyAccountService } from './domain/accounts/money-account-service.js';
import type { PasswordSettings } from './composition/identity.js';
import type { LedgerService } from './domain/ledger/ledger-service.js';
import type { PaymentService } from './domain/payments/payment-service.js';
import type { OrganisationName } from './domain/ports/organisation-name.js';
import type { TransactionManager } from './domain/ports/transaction.js';
import type { ReceiptService } from './domain/receipts/receipt-service.js';
import type { FileStore } from '@onengo/kernel/ports';
import type { IdempotencyStore } from './infrastructure/http/idempotency.js';
import type { JobRunner } from './infrastructure/jobs/jobs.js';
import type { JobView } from './runtime/records/ports/job-runner.js';
import type { EmailTransport, Logger } from '@onengo/kernel/ports';
import type { DispatchResult, OutboxDispatcher } from './infrastructure/outbox/outbox-dispatcher.js';
import type { PaymentProvider } from './domain/payments/ports/payment-provider.js';
import type { Database } from './infrastructure/postgres/db.js';
import type { RetentionPolicy, RetentionResult } from './infrastructure/postgres/retention.js';
import type { ExportSummary } from './infrastructure/postgres/tenant-export.js';
import type { TickResult, AutomationEngine } from './runtime/automation/automation-engine.js';
import type { DefinitionService } from './runtime/definitions/definition-service.js';
import type { IndexManager } from './runtime/definitions/index-manager.js';
import type { ModulePackage } from './runtime/definitions/package-loader.js';
import type { RuntimeService } from './runtime/definitions/runtime.js';
import type { SchemaRegistry } from './runtime/definitions/schema-registry.js';
import type { RecordAggregates } from './runtime/records/aggregates.js';
import type { RecordService } from './runtime/records/record-service.js';
import type { ScriptSandbox, ScriptWorkerEntry } from './runtime/scripts/sandbox.js';
import type { ApprovalService } from './runtime/workflows/approval-service.js';
import { assertDeploymentPrepared as assertPrepared, wireDefinitions } from './composition/definitions.js';
import { wireAdministration } from './composition/administration.js';
import { registerOutboxHandlers } from './composition/handlers.js';
import { httpDeps, wireBuilderSupport } from './composition/http.js';
import { wireIdentity } from './composition/identity.js';
import type { AuditTrail } from './domain/ports/audit-trail.js';
import { wireCryptography, wireInfrastructure, type Paths } from './composition/infrastructure.js';
import { wireFiles } from './composition/files.js';
import { wireMigration } from './composition/migration.js';
import type { MigrationService } from './application/migration/migration-service.js';
import { ReportProviders } from './application/reports/model.js';
import { ReportService } from './application/reports/report-service.js';
import { PgPublishedReportStore } from './infrastructure/postgres/stores/published-report-store.js';
import { wireJobs } from './composition/jobs.js';
import { wireMessaging } from './composition/messaging.js';
import { wireOperations } from './composition/operations.js';
import { wirePayments } from './composition/payments.js';
import { financeServices as wireFinance, wireRecords } from './composition/records.js';
import { wireScheduler, type Scheduler } from './composition/scheduler.js';

const SOURCE = import.meta.url.endsWith('.ts');
const ROOT = SOURCE ? join(dirname(fileURLToPath(import.meta.url)), '..') : dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = SOURCE ? join(ROOT, '..', '..') : ROOT;
const SHARED_PRODUCT_ROOT = SOURCE ? join(ROOT, '..', 'product') : join(ROOT, 'product');
export const MIGRATIONS_DIR = SOURCE ? join(ROOT, 'migrations') : join(ROOT, 'product', 'migrations');
export const MODULES_DIR = join(SHARED_PRODUCT_ROOT, 'modules');
/** Definitions every organisation has, published to the base layer by the deploy step. */
export const PLATFORM_DIR = SOURCE ? ROOT : join(ROOT, 'product', 'platform');
export const SCHEMA_DIR = join(SHARED_PRODUCT_ROOT, 'schemas');
export const WEB_DIST_DIR = SOURCE ? join(REPOSITORY_ROOT, 'apps', 'onengo', 'web', 'dist', 'web', 'browser') : join(ROOT, 'web');
/** The message catalogue (JSON per locale), shared with the web app. */
export const LOCALE_DIR = join(SHARED_PRODUCT_ROOT, 'locale');
export const LOCAL_FILES_DIR = join(REPOSITORY_ROOT, '.data', 'files');
/** The script worker thread: the TypeScript file under tsx from source, `dist/sandbox-worker.js` beside the bundle. */
export const SANDBOX_WORKER: ScriptWorkerEntry = SOURCE
  ? { file: join(ROOT, 'src', 'runtime', 'scripts', 'sandbox-worker.ts'), execArgv: ['--import', 'tsx'] }
  : { file: join(ROOT, 'sandbox-worker.js') };

/** Where the product's files live, for the composition that needs them. */
export const PATHS: Paths = {
  migrations: MIGRATIONS_DIR,
  modules: MODULES_DIR,
  platform: PLATFORM_DIR,
  schemas: SCHEMA_DIR,
  locale: LOCALE_DIR,
  localFiles: LOCAL_FILES_DIR,
  web: WEB_DIST_DIR,
  sandboxWorker: SANDBOX_WORKER,
};

/** The ledger and numbered receipts on their PostgreSQL stores. */
export const financeServices = wireFinance;

export interface Platform extends Scheduler {
  db: Database;
  schemas: SchemaRegistry;
  definitions: DefinitionService;
  records: RecordService;
  shares: RecordSharing;
  bulk: BulkService;
  ledger: LedgerService;
  receipts: ReceiptService;
  identity: IdentityService;
  /** Passkeys: sign-in with a device passkey, and the person's own passkeys. */
  passkeys: PasskeyService;
  roles: RolesService;
  people: PeopleService;
  profiles: ProfileService;
  /** Consent records and erasure of data subjects by pseudonymisation. */
  privacy: PrivacyService;
  pins: PinService;
  administration: AdministrationService;
  /** The organisation's own identity, logo and setup checklist, and its public sign-in identity. */
  organisation: OrganisationService;
  oidc: OidcService;
  approvals: ApprovalService;
  notifications: NotificationService;
  connectors: ConnectorService;
  automations: AutomationEngine;
  moneyAccounts: MoneyAccountService;
  payments: PaymentService;
  actions: ActionService;
  /** Custom reports: their data model, and the JSON a published file is rebuilt from. */
  reports: ReportService;
  printView: ReceiptPrintService;
  dispatcher: OutboxDispatcher;
  jobs: JobRunner;
  indexes: IndexManager;
  aggregates: RecordAggregates;
  runtime: RuntimeService;
  files: FileService;
  imports: ImportService;
  /** Data migration: CSV files of another system mapped onto record types, run in order. */
  migration: MigrationService;
  apiKeys: ApiKeyService;
  logger: Logger;
  /** What the HTTP layer is given: one typed bundle per route area. */
  http: HttpDeps;
  /** The Builder's check, try and review support; modulesDir points it at another folder of shipped modules (tests). */
  builderSupport(modulesDir?: string): BuilderSupport;
}

export interface PlatformOptions {
  /** At least 32 characters; signs access tokens. */
  tokenSecret: string;
  /** 32 bytes; encrypts two-step secrets, connector credentials and sensitive record values. */
  encryptionKey: Buffer;
  /** Keys used before `encryptionKey`; sensitive record values and stored secrets under them still decrypt until re-encrypted. */
  previousEncryptionKeys?: Buffer[];
  definitionCacheCheckMs?: number;
  /** Used when an NGO has no SMTP connector of its own. */
  defaultEmailTransport?: EmailTransport;
  paymentProviders?: PaymentProvider[];
  logger?: Logger;
  retention?: RetentionPolicy;
  /** Public address of the web app, used in emailed links and as the sign-in provider redirect. */
  publicBaseUrl?: string;
  /** Extra page origins allowed to run passkey ceremonies, e.g. a separately hosted web app. The public address's own origin is always allowed. */
  passkeyOrigins?: string[];
  /** Sign-in providers available to every NGO, e.g. Google configured by the installation. */
  oidcProviders?: OidcProviderConfig[];
  /** Replaces outbound HTTP for sign-in providers (tests). */
  oidcFetch?: HttpFetch;
  /** Rules for new passwords, including the optional online breached-password check. */
  passwords?: PasswordSettings;
  /** Time budget for scheduled automations in one tick; App Engine cron requests time out after 10 minutes. */
  tickBudgetMs?: number;
  /** Resident memory in MB above which each tick logs a `memory.high` alert. Default 300. */
  memoryAlertMb?: number;
  /** Start background jobs as soon as they are created, besides on each tick. Default true. */
  autoRunJobs?: boolean;
  /** Screen text by locale; read from the `locale` folder when not given. */
  localeCatalogues?: Record<string, unknown>;
  /** Replaces outbound HTTP for SMS, WhatsApp and webhook connectors (tests). */
  connectorHttp?: ConnectorHttp;
  /** Where uploaded files are kept (Cloud Storage when hosted); local disk under `.data/files` when not given. */
  fileStore?: FileStore;
  /** Upload size limit and the default storage quota per organisation. */
  files?: FileLimits;
  /** Rows a CSV export streams at once; larger exports become a job. Default 50,000. */
  exportInlineRows?: number;
  /** Records a bulk operation handles at once; larger selections become a job. Default 50. */
  bulkInlineRecords?: number;
  /** Most records one bulk operation may cover. Default 5,000. */
  bulkMaxRecords?: number;
  /**
   * Product assets and worker entry used by this platform instance. Process
   * entry points must pass these explicitly; omission remains for test
   * compatibility while the repository is a single package.
   */
  paths?: Paths;
}

/** What process start checks instead of doing it: every required migration is applied. */
export function assertDeploymentPrepared(db: Database, paths: Paths = PATHS): Promise<void> {
  return assertPrepared(db, paths);
}

/** Every capability is wired in src/composition/; this file only calls them in dependency order. */
export async function createPlatform(db: Database, options: PlatformOptions): Promise<Platform> {
  const base = wireInfrastructure(db, options, options.paths ?? PATHS);
  const defs = await wireDefinitions(base);
  const crypto = wireCryptography(options);
  const finance = wireFinance(base.sequences);
  const messaging = wireMessaging(base, defs, crypto);
  const recs = wireRecords(base, defs, crypto, finance, messaging);
  const identity = wireIdentity(base, defs, crypto, messaging, recs);
  const payments = wirePayments(base, defs, crypto, recs, finance);
  const jobs = wireJobs(base, defs, recs, messaging, identity);
  const files = wireFiles(base, defs, recs, jobs);
  const migration = wireMigration(base, defs, recs, finance, jobs, files);
  const admin = wireAdministration(base, defs, crypto, identity, files);
  const ops = wireOperations(base, defs, recs, finance, messaging, payments, jobs, files, crypto, admin, identity.apiKeys);
  const reports = new ReportService(base.tm, defs.definitions, recs.records, recs.aggregates, files.files, jobs.jobs, base.audit, base.sandbox, defs.organisationName, new ReportProviders(), new PgPublishedReportStore());
  registerOutboxHandlers(base, defs, recs, messaging, jobs, ops);
  const scheduler = wireScheduler(base, defs, recs, files, jobs, ops);
  const http = httpDeps(base, defs, recs, finance, messaging, identity, payments, jobs, files, ops, admin, scheduler, reports, migration);
  // The platform extends the scheduler object itself, so the HTTP layer's tick is the platform's tick even when a test replaces it.
  return Object.assign(scheduler, {
    db,
    schemas: base.schemas,
    definitions: defs.definitions,
    records: recs.records,
    shares: ops.shares,
    bulk: ops.bulk,
    ledger: finance.ledger,
    receipts: finance.receipts,
    identity: identity.identity,
    passkeys: identity.passkeys,
    roles: identity.roles,
    people: identity.people,
    profiles: recs.profiles,
    privacy: admin.privacy,
    pins: identity.pins,
    administration: admin.administration,
    organisation: admin.organisation,
    oidc: identity.oidc,
    approvals: ops.approvals,
    notifications: messaging.notifications,
    connectors: messaging.connectors,
    automations: ops.automations,
    moneyAccounts: payments.moneyAccounts,
    payments: payments.payments,
    actions: ops.actions,
    reports,
    printView: ops.printView,
    dispatcher: jobs.dispatcher,
    jobs: jobs.jobs,
    indexes: jobs.indexes,
    aggregates: recs.aggregates,
    runtime: defs.runtime,
    files: files.files,
    imports: files.imports,
    migration: migration.migration,
    apiKeys: identity.apiKeys,
    logger: base.logger,
    builderSupport: (modulesDir?: string) => wireBuilderSupport(base, defs, recs, messaging, identity, jobs, modulesDir),
    http,
  });
}
