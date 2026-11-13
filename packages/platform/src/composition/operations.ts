import { ActionService } from '../application/actions/action-service.js';
import { DataFeedService } from '../application/actions/data-feed.js';
import type { RecordsInTx } from '../application/actions/ports/action-ports.js';
import { PublicFormService } from '../application/actions/public-form.js';
import { ReceiptLinkService } from '../application/actions/receipt-link.js';
import type { ApiKeyService } from '../application/identity/api-key-service.js';
import { postgresAdministrationStore } from '../infrastructure/postgres/stores/administration-store.js';
import { PgRecordQueries } from '../infrastructure/postgres/stores/record-queries.js';
import { PostgresPublicFormLinkStore } from '../infrastructure/postgres/stores/public-form-link-store.js';
import { PostgresReceiptLinkStore } from '../infrastructure/postgres/stores/receipt-link-store.js';
import { ReceiptPrintService } from '../application/actions/receipt-print.js';
import { ConfirmPayment } from '../application/payments/confirm-payment.js';
import { BulkService } from '../application/records/bulk-service.js';
import { RecordSharing } from '../application/records/record-sharing.js';
import { enqueueThrough, recordsInTx } from '../application/records/records-in-tx.js';
import { PgApprovalStore } from '../infrastructure/postgres/stores/approval-store.js';
import { PgAutomationStore } from '../infrastructure/postgres/stores/automation-store.js';
import { AutomationEngine } from '../runtime/automation/automation-engine.js';
import { ShareService } from '../runtime/records/shares.js';
import { ApprovalService } from '../runtime/workflows/approval-service.js';
import type { Administration } from './administration.js';
import type { Definitions } from './definitions.js';
import type { Files } from './files.js';
import type { Base, Cryptography } from './infrastructure.js';
import type { Jobs } from './jobs.js';
import type { Messaging } from './messaging.js';
import type { Payments } from './payments.js';
import type { Finance, Records } from './records.js';

/** What people and automations do with records: approvals, automations, sharing, actions, bulk operations, printing, paid steps. */
export function wireOperations(
  base: Base,
  { definitions }: Definitions,
  { records }: Records,
  finance: Finance,
  { notifications }: Messaging,
  { payments }: Payments,
  { jobs }: Jobs,
  { files, exports }: Files,
  { crypto }: Cryptography,
  { organisation }: Administration,
  apiKeys: Pick<ApiKeyService, 'authenticateFeed'>,
) {
  const { tm, owner, options, audit } = base;
  const approvals = new ApprovalService(tm, new PgApprovalStore(), definitions, records, audit);
  const recordsIn: RecordsInTx = recordsInTx(records);
  const automations = new AutomationEngine(tm, new PgAutomationStore(), owner.tenants, definitions, records, notifications, (tenantId, tx) =>
    recordsIn(tenantId, tx, definitions), audit,
  );
  const shares = new RecordSharing(new ShareService(tm, definitions, records), notifications);
  const actions = new ActionService(tm, definitions, recordsIn, enqueueThrough(audit), payments, finance.receipts);
  const bulk = new BulkService(tm, definitions, records, actions, shares, exports, jobs, options.bulkInlineRecords, options.bulkMaxRecords);
  const receiptLinks = new ReceiptLinkService(tm, new PostgresReceiptLinkStore(base.db), definitions, records, finance.receipts, files, crypto, audit);
  const publicForms = new PublicFormService(tm, organisation, definitions, records, new PostgresPublicFormLinkStore(base.db), crypto, audit);
  const dataFeeds = new DataFeedService(tm, organisation, definitions, new PgRecordQueries(), postgresAdministrationStore(base.sequences), apiKeys);
  return {
    approvals,
    automations,
    shares,
    actions,
    bulk,
    receiptLinks,
    publicForms,
    dataFeeds,
    printView: new ReceiptPrintService(tm, definitions, records, finance.receipts, receiptLinks),
    confirmPayment: new ConfirmPayment(tm, definitions, payments, recordsIn),
  };
}
export type Operations = ReturnType<typeof wireOperations>;
