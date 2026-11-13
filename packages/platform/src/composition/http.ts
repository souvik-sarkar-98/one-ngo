import { PrintReceipt, RunAction } from '../application/actions/action-use-cases.js';
import { ConnectorOverview, AdminJobs, MemberRoles } from '../application/admin/http-api.js';
import { OpenApiDocument } from '../application/admin/openapi-document.js';
import { RequestAuthenticator } from '../application/auth/http-api.js';
import { SignIn } from '../application/auth/sign-in.js';
import { TenantExportUseCase } from '../application/administration/tenant-export.js';
import { BuilderSupport } from '../application/definitions/builder-support.js';
import { BuilderDefinitions, InspectDefinition, PublishDefinition, RollbackDefinition, SaveDefinitionDraft } from '../application/definitions/definition-use-cases.js';
import { DatabaseRejections, type HttpDeps } from '../application/internal/http-api.js';
import { OrganisationSignIn, SignatoryImage } from '../application/organisations/http-api.js';
import { ConfirmPaymentManually, HandlePaymentWebhook, RequestPayment } from '../application/payments/confirm-payment.js';
import { EraseSubject, RecordConsent } from '../application/privacy/privacy-use-cases.js';
import { RecordReceipts } from '../application/records/http-api.js';
import {
  AggregateRecords,
  CreateRecord,
  GetDefinition,
  GetRecord,
  ListRecords,
  QueryApprovals,
  QueryRecords,
  RecordApproval,
  TransitionRecord,
  UpdateRecord,
} from '../application/records/record-use-cases.js';
import { CurrentPerson } from '../application/session/http-api.js';
import { safeEqual, sha256 } from '@onengo/kernel/crypto';
import { opensInline } from '@onengo/kernel/files';
import { IdempotencyStore } from '../infrastructure/http/idempotency.js';
import { MemoryRateLimiter } from '@onengo/kernel/http';
import { ALERT } from '@onengo/kernel/observability';
import { databaseErrorOf, fromDatabaseError, UNIQUE_VIOLATION } from '../infrastructure/postgres/db-errors.js';
import { databaseReady } from '../infrastructure/postgres/readiness.js';
import { errorResponse } from '../http/contracts/errors.js';
import { platformErrorOf } from './infrastructure-errors.js';
import type { Administration } from './administration.js';
import type { Definitions } from './definitions.js';
import type { Files } from './files.js';
import type { Base } from './infrastructure.js';
import type { Identity } from './identity.js';
import type { Jobs } from './jobs.js';
import type { Messaging } from './messaging.js';
import type { Operations } from './operations.js';
import type { Payments } from './payments.js';
import type { Finance, Records } from './records.js';
import type { ReportService } from '../application/reports/report-service.js';
import type { Scheduler } from './scheduler.js';
import type { Migration } from './migration.js';

/** Builder check, try and review support over the shipped modules in `modulesDir` (the product's `modules/` unless a test points elsewhere). */
export function wireBuilderSupport(
  { tm, schemas, sandbox, paths }: Base,
  { definitions, builderStore }: Definitions,
  { records }: Records,
  { notifications }: Messaging,
  { identity }: Identity,
  { indexes }: Jobs,
  modulesDir = paths.modules,
): BuilderSupport {
  return new BuilderSupport({ transactions: tm, builderStore, schemas, definitions, records, sandbox, identity, notifications, indexes }, modulesDir);
}

/** The typed bundle each HTTP route area is given: the application's public API for that area, never the whole platform. */
export function httpDeps(
  base: Base,
  defs: Definitions,
  recs: Records,
  { receipts }: Finance,
  messaging: Messaging,
  id: Identity,
  { moneyAccounts, payments }: Payments,
  jobsWiring: Jobs,
  { files, imports, exports }: Files,
  { approvals, shares, actions, bulk, printView, receiptLinks, publicForms, dataFeeds }: Operations,
  { privacy, administration, organisation }: Administration,
  scheduler: Scheduler,
  reports: ReportService,
  { migration }: Migration,
): HttpDeps {
  const { db, tm, audit, logger, idempotency } = base;
  const { definitions, organisationName, runtime } = defs;
  const { records, aggregates } = recs;
  const { notifications, connectors, oauthCredentials } = messaging;
  const { identity, roles, people, pins, access, oidc, apiKeys, passkeys } = id;
  const { dispatcher, jobs, indexes } = jobsWiring;
  return {
    server: { logger, kickOutbox: () => dispatcher.kick(), rateLimiter: (limit, windowMs) => new MemoryRateLimiter(limit, windowMs) },
    errors: {
      logger,
      alerts: { httpUnhandledError: ALERT.httpUnhandledError },
      rejections: new DatabaseRejections(
        databaseErrorOf,
        (error, field) => {
          const mapped = fromDatabaseError(error, field);
          return mapped && platformErrorOf(mapped);
        },
        UNIQUE_VIOLATION,
        indexes,
      ),
    },
    authenticator: new RequestAuthenticator(identity, apiKeys),
    internal: { readiness: { isReady: () => databaseReady(db) }, scheduler: { run: () => scheduler.tick() }, safeEqual, logger },
    auth: { signIn: new SignIn(identity), identity, oidc, passkeys, connectorOauth: oauthCredentials, logger },
    publicOrganisation: { signIn: new OrganisationSignIn(organisation, oidc), logos: organisation },
    publicReceipts: receiptLinks,
    publicForms,
    dataFeeds,
    webhooks: { paymentWebhook: new HandlePaymentWebhook(payments) },
    session: { identity, passkeys, runtime, pins, notifications, me: new CurrentPerson(identity, runtime, roles) },
    records: {
      createRecord: new CreateRecord(records),
      updateRecord: new UpdateRecord(records),
      transitionRecord: new TransitionRecord(records),
      getRecord: new GetRecord(records),
      listRecords: new ListRecords(records),
      queryRecords: new QueryRecords(records),
      aggregateRecords: new AggregateRecords(runtime, aggregates),
      shares,
      bulk,
      runAction: new RunAction(actions),
      printReceipt: new PrintReceipt(printView),
      receiptLinks,
      publicForms,
      approvals,
      queryApprovals: new QueryApprovals(approvals),
      recordApproval: new RecordApproval(records, approvals),
      getDefinition: new GetDefinition(definitions),
      receipts: new RecordReceipts(records, tm, receipts),
      idempotency: {
        requestHash: (method, path, body) => IdempotencyStore.requestHash(method, path, body),
        run: (ctx, key, requestHash, fn) => idempotency.run(ctx, key, requestHash, fn),
      },
    },
    builder: {
      definitions: new BuilderDefinitions(definitions),
      inspect: new InspectDefinition(definitions),
      saveDraft: new SaveDefinitionDraft(definitions),
      publish: new PublishDefinition(definitions),
      rollback: new RollbackDefinition(definitions),
      support: wireBuilderSupport(base, defs, recs, messaging, id, jobsWiring),
    },
    payments: { moneyAccounts, payments, requestPayment: new RequestPayment(actions), confirmPayment: new ConfirmPaymentManually(payments) },
    admin: {
      roles,
      access,
      people,
      administration,
      apiKeys,
      connectors,
      connectorOauth: oauthCredentials,
      memberRoles: new MemberRoles(roles, people),
      jobs: new AdminJobs(jobs),
      connectorOverview: new ConnectorOverview(definitions, connectors),
      openApi: new OpenApiDocument({ organisationName, definitions, sha256, errorSchema: errorResponse }),
    },
    organisation: { organisation, signatures: new SignatoryImage(organisation, printView) },
    files: {
      files,
      imports,
      exports,
      jobs,
      tenantExport: new TenantExportUseCase(tm, audit, (tenantId, writeLine) => scheduler.exportTenant(tenantId, writeLine)),
      opensInline,
      logger,
    },
    reports: { reports },
    migration: { migrations: migration },
    privacy: { recordConsent: new RecordConsent(privacy), eraseSubject: new EraseSubject(privacy), consent: privacy },
  };
}
