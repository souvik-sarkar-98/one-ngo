import {
  contracted,
  type ActionRequest,
  type AggregateRequestBody,
  type ApprovalDecisionRequest,
  type BulkRequest,
  type CreateRecordRequest,
  type RecordQueryRequest,
  type TransitionRequest,
  type UpdateRecordRequest,
} from '../../contracts';
import type { FileDownload, FileHttp, HttpLike } from '../../http/http';
import type { ActionRunResult, PendingApproval, QueryResult, Receipt, ReceiptPrint, RecordView, SaveResult } from '../../models';
import type { AggregateResult, PagesGateway } from '../../pages';
import type { RecordsGateway } from './gateway';
import type { CheckResult, ExportOutcome, ImportExportGateway, ImportView, JobView } from '../import/import-session';
import type { BulkAnswer, BulkGateway, BulkJob, BulkJobItem } from '../bulk/selection';
import type { Share, ShareCandidate, SharesGateway } from '../sharing/sharing';

export type { HttpLike } from '../../http/http';

const base = (type: string) => `/api/records/${encodeURIComponent(type)}`;
const one = (type: string, id: string) => `${base(type)}/${encodeURIComponent(id)}`;

/** The records routes with fixed contracts: the server checks the envelope, the published definitions what is inside. */
export interface RecordRoutes {
  'POST /api/records/:type': { body: CreateRecordRequest; answer: SaveResult };
  'POST /api/records/:type/query': { body: RecordQueryRequest; answer: QueryResult };
  'POST /api/records/:type/aggregate': { body: AggregateRequestBody; answer: AggregateResult };
  'POST /api/records/:type/bulk': { body: BulkRequest; answer: BulkAnswer };
  'PATCH /api/records/:type/:id': { body: UpdateRecordRequest; answer: SaveResult };
  'POST /api/records/:type/:id/transitions/:transition': { body: TransitionRequest; answer: SaveResult };
  'POST /api/records/:type/:id/actions/:key': { body: ActionRequest; answer: ActionRunResult };
  'POST /api/approvals/:id/decision': { body: ApprovalDecisionRequest; answer: { status: string; message?: string } };
}

/** The records API over HTTP. Every records URL in the web app lives here. */
export function httpGateway(http: HttpLike): RecordsGateway {
  const send = contracted<RecordRoutes>(http);
  return {
    query: (type, body) => send('POST /api/records/:type/query', { type }, body),
    get: (type, id) => http.get<RecordView>(one(type, id)),
    create: (type, data) => send('POST /api/records/:type', { type }, data),
    update: (type, id, data, expectedVersion) => send('PATCH /api/records/:type/:id', { type, id }, { data, expectedVersion }),
    transition: (type, id, transition, data, expectedVersion) =>
      send('POST /api/records/:type/:id/transitions/:transition', { type, id, transition }, { data, expectedVersion }),
    runAction: (type, id, key, input, expectedVersion) => send('POST /api/records/:type/:id/actions/:key', { type, id, key }, { input, expectedVersion }),
    receipts: (type, id) => http.get<Receipt[]>(`${one(type, id)}/receipts`),
    printReceipt: (receiptId) => http.get<ReceiptPrint>(`/api/print/receipt/${encodeURIComponent(receiptId)}`),
    createReceiptLink: (receiptId) => http.post<{ path: string }>(`/api/print/receipt/${encodeURIComponent(receiptId)}/link`, {}),
    revokeReceiptLink: (receiptId) => http.delete<void>(`/api/print/receipt/${encodeURIComponent(receiptId)}/link`),
    pendingApproval: async (type, id) => (await http.get<{ pending: PendingApproval | null }>(`${one(type, id)}/approval`)).pending,
    decide: (id, decision) => send('POST /api/approvals/:id/decision', { id }, { decision }),
  };
}

/** Counts and totals for page widgets. */
export function httpAggregate(http: HttpLike): PagesGateway['aggregate'] {
  const send = contracted<RecordRoutes>(http);
  return (type, body) => send('POST /api/records/:type/aggregate', { type }, body);
}

function base64url(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const outcome = (answer: FileDownload | { json: unknown }): ExportOutcome =>
  'json' in answer ? { kind: 'job', jobId: String((answer.json as { jobId?: unknown }).jobId ?? '') } : { kind: 'file', file: answer };

/** CSV import and export over HTTP. */
export function httpImportExportGateway(http: FileHttp): ImportExportGateway {
  const imp = (id: string) => `/api/imports/${encodeURIComponent(id)}`;
  return {
    upload: (type, file, fileName) => http.upload<ImportView>(`${base(type)}/imports`, file, fileName),
    get: (id) => http.get<ImportView>(imp(id)),
    setMapping: (id, mapping) => http.put<ImportView>(`${imp(id)}/mapping`, mapping),
    check: (id) => http.post<CheckResult>(`${imp(id)}/check`),
    run: (id) => http.post<ImportView>(`${imp(id)}/run`),
    job: (id) => http.get<JobView>(`/api/jobs/${encodeURIComponent(id)}`),
    cancelJob: (id) => http.post<JobView>(`/api/jobs/${encodeURIComponent(id)}/cancel`),
    failedRows: async (id) => {
      const answer = await http.download('GET', `${imp(id)}/failed.csv`);
      if ('json' in answer) throw new Error('Expected a file.');
      return answer;
    },
    exportList: async (type, query) => outcome(await http.download('GET', `${base(type)}/export.csv?q=${base64url(JSON.stringify(query))}`)),
    exportSelected: async (type, ids) => outcome(await http.download('POST', `${base(type)}/bulk`, { ids, operation: { type: 'export' } } satisfies BulkRequest)),
  };
}

/** A record's shares over HTTP. */
export function httpShares(http: HttpLike): SharesGateway {
  const shares = (type: string, id: string) => `${one(type, id)}/shares`;
  return {
    list: (type, id) => http.get<Share[]>(shares(type, id)),
    share: (type, id, input) => http.post<Share>(shares(type, id), input),
    remove: (type, id, shareId) => http.delete<void>(`${shares(type, id)}/${encodeURIComponent(shareId)}`),
    candidates: async (type, id, q) => (await http.get<{ items: ShareCandidate[] }>(`${shares(type, id)}/candidates?q=${encodeURIComponent(q)}`)).items,
  };
}

/** Bulk operations over HTTP; Export goes through the import and export gateway. */
export function httpBulkGateway(http: HttpLike): BulkGateway {
  const send = contracted<RecordRoutes>(http);
  const job = (id: string) => `/api/jobs/${encodeURIComponent(id)}`;
  return {
    run: (type, target, operation) => send('POST /api/records/:type/bulk', { type }, { ...target, operation }),
    job: (id) => http.get<BulkJob>(job(id)),
    failedItems: async (id) => (await http.get<{ items: BulkJobItem[] }>(`${job(id)}/items?status=failed`)).items,
    cancelJob: (id) => http.post<BulkJob>(`${job(id)}/cancel`),
  };
}
