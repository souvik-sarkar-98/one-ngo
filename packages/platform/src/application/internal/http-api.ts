import type { AdminApi } from '../admin/http-api.js';
import type { AuthApi, Authenticator } from '../auth/http-api.js';
import type { BuilderApi } from '../builder/http-api.js';
import type { FilesApi } from '../files/http-api.js';
import type { ReportsApi } from '../reports/http-api.js';
import type { MigrationsApi } from '../migration/http-api.js';
import type { OrganisationApi, PublicOrganisationApi } from '../organisations/http-api.js';
import type { DataFeedService } from '../actions/data-feed.js';
import type { PublicFormService } from '../actions/public-form.js';
import type { PublicReceipts } from '../records/http-api.js';
import type { PaymentsApi, WebhooksApi } from '../payments/http-api.js';
import type { PrivacyApi } from '../privacy/http-api.js';
import type { RecordsApi } from '../records/http-api.js';
import type { SessionApi } from '../session/http-api.js';
import type { ApplicationError, HttpLogger } from '../shared/http-api.js';
import type { DatabaseRejection, RejectionExplainer, UniqueFieldLookup } from './ports/internal-ports.js';

export type { DatabaseRejection } from './ports/internal-ports.js';

/** Host probes and the scheduler tick. */
export interface InternalApi {
  readiness: Readiness;
  scheduler: SchedulerTick;
  /** Constant-time comparison of two secrets. */
  safeEqual(a: string, b: string): boolean;
  logger: HttpLogger;
}

/** Whether the database answers within the probe's time budget. */
export interface Readiness {
  isReady(): Promise<boolean>;
}

/** What one scheduler run did; the tick route answers with all of it. */
export type TickOutcome = {
  automations: { tenants: number; recordsProcessed: number; incomplete?: boolean };
  dispatch: { processed: number; failed: number };
} & Record<string, unknown>;

/** The scheduler entry point: scheduled automations, queued work, background jobs, then cleanup. */
export interface SchedulerTick {
  run(): Promise<TickOutcome>;
}

/** A per-client request counter for one window. */
export interface RateLimiter {
  hit(key: string): boolean;
}

/** What the server needs for every request: the log, the rate limits and the queued-work nudge. */
export interface ServerApi {
  logger: HttpLogger;
  /** Starts queued outbox work after a write. */
  kickOutbox(): void;
  rateLimiter(limit: number, windowMs: number): RateLimiter;
}

export interface DatabaseErrorInfo {
  code: string;
  message: string;
  constraint?: string;
}

/** Turns the database's own rejections (a duplicate value, a rule it enforces) into the errors routes answer with. */
export class DatabaseRejections {
  constructor(
    private readonly errorOf: (error: unknown) => DatabaseErrorInfo | undefined,
    private readonly translate: (error: DatabaseErrorInfo, field?: string) => ApplicationError | undefined,
    private readonly uniqueViolation: string,
    private readonly indexes: UniqueFieldLookup,
  ) {}

  async explain(error: unknown): Promise<DatabaseRejection | undefined> {
    const dbError = this.errorOf(error);
    if (!dbError) return undefined;
    const field =
      dbError.code === this.uniqueViolation && dbError.constraint ? await this.indexes.uniqueField(dbError.constraint).catch(() => undefined) : undefined;
    const mapped = this.translate(dbError, field);
    return mapped ? { mapped, code: dbError.code, constraint: dbError.constraint, message: dbError.message } : undefined;
  }
}

/** What the error handler needs: the log, the alert name for unhandled errors, and the database rejections. */
export interface ErrorsApi {
  logger: HttpLogger;
  alerts: { httpUnhandledError: string };
  rejections: RejectionExplainer;
}

/** What a graceful shutdown stops: queued outbox work, then the database pool. */
export interface ShutdownHost {
  dispatcher: { stop(): Promise<unknown> };
  db: { close(): Promise<void> };
  logger: HttpLogger;
}

/** Everything the HTTP layer is given, one bundle per route area. */
export interface HttpDeps {
  server: ServerApi;
  errors: ErrorsApi;
  authenticator: Authenticator;
  internal: InternalApi;
  auth: AuthApi;
  publicOrganisation: PublicOrganisationApi;
  publicReceipts: PublicReceipts;
  publicForms: Pick<PublicFormService, 'form' | 'catalogue' | 'submit' | 'open' | 'change' | 'remove'>;
  dataFeeds: Pick<DataFeedService, 'access' | 'published' | 'authenticate' | 'read'>;
  webhooks: WebhooksApi;
  session: SessionApi;
  records: RecordsApi;
  builder: BuilderApi;
  payments: PaymentsApi;
  admin: AdminApi;
  organisation: OrganisationApi;
  files: FilesApi;
  reports: ReportsApi;
  migration: MigrationsApi;
  privacy: PrivacyApi;
}

/** What buildServer is handed: anything carrying the HTTP bundles. */
export interface HttpHost {
  http: HttpDeps;
}
