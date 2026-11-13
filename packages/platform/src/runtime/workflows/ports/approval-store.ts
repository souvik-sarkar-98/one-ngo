import type { Tx } from '../../../domain/ports/transaction.js';

export type ApprovalSortField = 'waiting' | 'record' | 'type' | 'step' | 'requestedBy';

export type RequestStatus = 'approved' | 'rejected' | 'withdrawn' | 'stale';

/** An approval request with its record, requester and decisions so far, as the deciding person sees it. */
export interface RequestRow {
  id: string;
  record_id: string;
  transition_key: string;
  requested_by: string;
  data: Record<string, unknown>;
  record_version: number;
  required_approvals: number;
  status: string;
  type_key: string;
  number: string | null;
  current_version: number;
  created_at: Date | string;
  requester_name: string | null;
  approvals: number;
  decided_by_me: boolean;
}

/** A pending request in the approvals list. */
export interface ApprovalListRow {
  id: string;
  record_id: string;
  type_key: string;
  transition_key: string;
  number: string | null;
  /** The stored value of the pair's title field; null when empty or not readable. */
  title: string | null;
  status: string;
  workflow_state: Record<string, string> | null;
  requested_by: string;
  requester_name: string | null;
  required_approvals: number;
  approvals: number;
  created_at: Date | string;
}

/** A (record type, step) the person may approve, with the labels the list sorts by. */
export interface ApprovalPair {
  type: string;
  step: string;
  typeLabel: string;
  stepLabel: string;
  /** The field shown and searched as the record's title, when the person may read it. */
  titleField: string | null;
}

export interface ApprovalListQuery {
  types?: string[];
  steps?: string[];
  requestedBy?: string[];
  /** Matched against the record number and title. */
  search?: string;
  sort: { field: ApprovalSortField; dir: 'asc' | 'desc' };
  limit: number;
  offset: number;
}

/**
 * Approval requests and decisions of the organisation in the open transaction.
 * "Eligible" requests are pending ones for the given pairs that the person
 * neither made nor already decided.
 */
export interface ApprovalStore {
  /** The request, or every pending request when `requestId` is null, oldest first. */
  requests(tx: Tx, actorId: string, requestId: string | null): Promise<RequestRow[]>;
  /** False when the person has already decided the request. */
  addDecision(tx: Tx, requestId: string, actorId: string, decision: 'approve' | 'reject', comment: string | null): Promise<boolean>;
  approvalsGiven(tx: Tx, requestId: string): Promise<number>;
  /** Decides the request; with `onlyIfPending`, leaves a request that is no longer pending alone. */
  setStatus(tx: Tx, requestId: string, status: RequestStatus, onlyIfPending?: boolean): Promise<void>;
  eligible(tx: Tx, actorId: string, pairs: ApprovalPair[], q: ApprovalListQuery): Promise<{ rows: ApprovalListRow[]; total: number }>;
  eligibleCount(tx: Tx, actorId: string, pairs: ApprovalPair[]): Promise<number>;
}
