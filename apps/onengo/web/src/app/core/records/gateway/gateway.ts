import type { ActionRunResult, PendingApproval, QueryResult, Receipt, ReceiptPrint, RecordQueryBody, RecordView, SaveResult } from '../../models';

/** What the record screens need from the server. The only implementation that talks HTTP is in http-gateway.ts. */
export interface RecordsGateway {
  query(type: string, body: RecordQueryBody): Promise<QueryResult>;
  get(type: string, id: string): Promise<RecordView>;
  create(type: string, data: Record<string, unknown>): Promise<SaveResult>;
  update(type: string, id: string, data: Record<string, unknown>, expectedVersion: number): Promise<SaveResult>;
  transition(type: string, id: string, step: string, data: Record<string, unknown>, expectedVersion: number): Promise<SaveResult>;
  runAction(type: string, id: string, action: string, input: Record<string, unknown>, expectedVersion: number): Promise<ActionRunResult>;
  receipts(type: string, id: string): Promise<Receipt[]>;
  printReceipt(receiptId: string): Promise<ReceiptPrint>;
  createReceiptLink(receiptId: string): Promise<{ path: string }>;
  revokeReceiptLink(receiptId: string): Promise<void>;
  pendingApproval(type: string, id: string): Promise<PendingApproval | null>;
  decide(approvalId: string, decision: 'approve' | 'reject'): Promise<{ status: string; message?: string }>;
}

/** An error as the server reports it: a message, a code, and per-field issues. */
export interface GatewayError {
  message: string;
  code?: string;
  issues?: { path: string; message: string }[];
}

export function asGatewayError(e: unknown, fallback: string): GatewayError {
  if (e && typeof e === 'object' && 'message' in e && 'code' in e) {
    const x = e as { message: string; code: string; issues?: { path: string; message: string }[] };
    return { message: x.message, code: x.code, issues: x.issues ?? [] };
  }
  return { message: fallback, issues: [] };
}
