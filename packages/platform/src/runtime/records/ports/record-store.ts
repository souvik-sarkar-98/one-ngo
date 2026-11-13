import type { AuditInput } from './audit-input.js';
import type { Tx } from '../../../domain/ports/transaction.js';

/** A stored record as read, under row-level security. */
export interface RecordRow {
  id: string;
  type_key: string;
  number: string | null;
  status: string | null;
  version: number;
  schema_version: number;
  data: Record<string, unknown>;
  workflow_key: string | null;
  workflow_state: Record<string, string>;
  owner_id: string | null;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** What a save writes: `data` as stored (sensitive values sealed) with the keyed hashes of unique sensitive values. */
interface WrittenRecord {
  status: string | null;
  schemaVersion: number;
  data: Record<string, unknown>;
  index: Record<string, string>;
  states: Record<string, string>;
  searchText: string;
  actorId: string;
}

export interface NewRecord extends WrittenRecord {
  typeKey: string;
  number: string | null;
  workflowKey: string | null;
}

export type RecordChanges = WrittenRecord;

export interface ScriptRun {
  key: string;
  version: number;
  /** Default `beforeSave`. */
  hook?: 'beforeSave' | 'validate' | 'afterSave' | 'workflowGuard' | 'customButton' | 'reportShape';
  durationMs: number;
  outcome: 'ok' | 'failed' | 'limit' | 'rejected';
  message: string | null;
  /** Count of proposed effects by type, and the journal total; absent when the run proposed nothing. */
  effects?: { count: Record<string, number>; journalTotal: string } | null;
}

/** The organisation settings a script may declare as inputs. */
export interface ScriptSettings {
  organisationName: string;
  financialYearStartMonth: number;
  defaultCurrency: string;
  receiptSeries: { key: string; label: string }[];
}

/** Balances as of a date: debits less credits, as two-decimal strings, by code. */
export interface LedgerBalances {
  accounts: Record<string, string>;
  funds: Record<string, string>;
}

/** A stored file a file or signature field may hold. */
export interface StoredFile {
  id: string;
  mime: string;
  size: string | number;
  record_id: string | null;
  field_key: string | null;
  created_by: string;
}

export interface ApprovalRequestInput {
  recordId: string;
  transitionKey: string;
  requestedBy: string;
  /** The step's values as stored, sensitive values sealed. */
  data: Record<string, unknown>;
  recordVersion: number;
  requiredApprovals: number;
}

/**
 * The records of the open transaction's organisation and what a save writes
 * beside them: files it links, script runs, approval requests, audit entries,
 * outbox events and record numbers.
 */
export interface RecordStore {
  /** The live record `id`. */
  get(tx: Tx, id: string): Promise<RecordRow | undefined>;
  /** Live records of `typeKey` whose `field` holds `value`. */
  linked(tx: Tx, typeKey: string, field: string, value: string): Promise<RecordRow[]>;
  /** The records `ids`, in no particular order. */
  getMany(tx: Tx, ids: string[]): Promise<RecordRow[]>;
  /** The record types of the live records among `ids`. */
  typesOf(tx: Tx, ids: string[]): Promise<{ id: string; type_key: string }[]>;
  versionOf(tx: Tx, id: string): Promise<number | undefined>;
  insert(tx: Tx, record: NewRecord): Promise<RecordRow>;
  /** Updates the live record at `expectedVersion`, raising its version; undefined when it has moved on or is gone. */
  update(tx: Tx, id: string, expectedVersion: number, changes: RecordChanges): Promise<RecordRow | undefined>;
  /** Marks the live record deleted at `expectedVersion`. Undefined when it has moved on or is gone. */
  softDelete(tx: Tx, id: string, expectedVersion: number, actorId: string): Promise<RecordRow | undefined>;
  /** Sets one rollup value on the live record `id` of `typeKey`. */
  setRollup(tx: Tx, typeKey: string, id: string, fieldKey: string, value: number): Promise<void>;
  /** Lays `values` over the record's data. */
  mergeData(tx: Tx, id: string, values: Record<string, number>): Promise<void>;
  setSearchText(tx: Tx, id: string, text: string): Promise<void>;
  /** One page of live records of a type after `afterId`, in id order. */
  page(tx: Tx, typeKey: string, afterId: string | null, limit: number): Promise<{ id: string; number: string | null; data: Record<string, unknown> }[]>;
  /** Like `page`, with the stored keyed hashes, the rows locked until the transaction ends. */
  lockStoredPage(tx: Tx, typeKey: string, afterId: string | null, limit: number): Promise<{ id: string; data: Record<string, unknown>; blind_index: Record<string, string> }[]>;
  /** Rewrites the stored data and keyed hashes without a new version. */
  restore(tx: Tx, id: string, stored: { data: Record<string, unknown>; index: Record<string, string> }): Promise<void>;
  countOfType(tx: Tx, typeKey: string): Promise<number>;
  /** Status and data of the live records of `typeKey` whose reference field `referenceKey` holds `parentId`. */
  children(tx: Tx, typeKey: string, referenceKey: string, parentId: string): Promise<{ status: string | null; data: Record<string, unknown> }[]>;
  /** Live records of a type, other than `exceptId`, whose unique field has one of the keyed hashes, in id order. */
  idsByHash(tx: Tx, typeKey: string, fieldKey: string, hashes: string[], exceptId: string | null, limit: number): Promise<string[]>;

  /** The best unexpired share of the record with the person or one of their roles. */
  shareAccess(tx: Tx, recordId: string, person: { id: string; roles: string[] }): Promise<'read' | 'edit' | undefined>;
  /** Steps of the record waiting for approval. */
  pendingApprovalSteps(tx: Tx, recordId: string): Promise<string[]>;
  hasPendingApproval(tx: Tx, recordId: string): Promise<boolean>;
  /** The new approval request's id. */
  addApprovalRequest(tx: Tx, input: ApprovalRequestInput): Promise<string>;

  /** The stored files among `ids` that are not deleted. */
  files(tx: Tx, ids: string[]): Promise<StoredFile[]>;
  /** Unlinks from the record's `fieldKeys` the files not among `keep`. */
  unlinkFiles(tx: Tx, recordId: string, fieldKeys: string[], keep: string[]): Promise<void>;
  linkFiles(tx: Tx, recordId: string, fieldKey: string, ids: string[]): Promise<void>;

  /** The display name of user `userId`. */
  userName(tx: Tx, userId: string): Promise<string | undefined>;
  logScript(tx: Tx, run: ScriptRun, recordId: string | null): Promise<void>;
  audit(tx: Tx, input: AuditInput): Promise<void>;
  enqueueEvent(tx: Tx, type: string, payload: unknown): Promise<void>;
  fiscalYearStartMonth(tx: Tx): Promise<number>;
  /** The next value of a gap-free counter, held until the transaction ends. */
  nextSequenceValue(tx: Tx, key: string, period: string): Promise<number>;

  /** The settings scripts may read; never secrets or connector settings. */
  scriptSettings(tx: Tx): Promise<ScriptSettings>;
  /** Posted balances of the accounts and funds up to and including `asOf`. */
  ledgerBalances(tx: Tx, accounts: string[], funds: string[], asOf: string): Promise<LedgerBalances>;
  /** The permissions of the organisation's role, or undefined when it does not exist. */
  rolePermissions(tx: Tx, role: string): Promise<string[] | undefined>;
}
