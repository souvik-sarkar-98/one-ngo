import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { ReceiptService } from '../../domain/receipts/receipt-service.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { ApprovalService } from '../../runtime/workflows/approval-service.js';
import type { PublicFormService } from '../actions/public-form.js';
import type { ReceiptLinkService } from '../actions/receipt-link.js';
import type { PrintReceipt, RunAction } from '../actions/action-use-cases.js';
import type { BulkService } from './bulk-service.js';
import type { RecordSharing } from './record-sharing.js';
import type {
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
} from './record-use-cases.js';
import type { Idempotency, RequestContext } from '../shared/http-api.js';

export { recordQueryOf } from './record-query.js';
export type { AggregateInput } from './record-use-cases.js';

/** A share with a person or role: who, what they may do, and until when. */
export type ShareInput = Parameters<RecordSharing['share']>[3];

/** Records, their shares, receipts and approvals, and published definitions. */
export interface RecordsApi {
  createRecord: CreateRecord;
  updateRecord: UpdateRecord;
  transitionRecord: TransitionRecord;
  getRecord: GetRecord;
  listRecords: ListRecords;
  queryRecords: QueryRecords;
  aggregateRecords: AggregateRecords;
  shares: Pick<RecordSharing, 'list' | 'candidates' | 'share' | 'remove'>;
  bulk: Pick<BulkService, 'run'>;
  runAction: RunAction;
  printReceipt: PrintReceipt;
  receiptLinks: Pick<ReceiptLinkService, 'ensure' | 'revoke'>;
  publicForms: Pick<PublicFormService, 'linkFor' | 'revoke'>;
  approvals: Pick<ApprovalService, 'inbox' | 'count' | 'decide' | 'withdraw'>;
  queryApprovals: QueryApprovals;
  recordApproval: RecordApproval;
  getDefinition: GetDefinition;
  receipts: RecordReceipts;
  idempotency: Idempotency;
}

/** The public receipt page: the view, and its logo or signature. */
export type PublicReceipts = Pick<ReceiptLinkService, 'view' | 'image'>;

/** The receipts issued for one record, once the caller is known to be allowed to read it. */
export class RecordReceipts {
  constructor(
    private readonly records: Pick<RecordService, 'get'>,
    private readonly transactions: TransactionManager,
    private readonly receipts: Pick<ReceiptService, 'forRecord'>,
  ) {}

  async forRecord(ctx: RequestContext, recordId: string) {
    const record = await this.records.get(ctx, recordId);
    return this.transactions.withTenant(ctx.tenantId, (tx) => this.receipts.forRecord(tx, record.id));
  }
}
