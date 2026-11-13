import type { Tx } from '../../../domain/ports/transaction.js';

export type SubjectKind = 'record' | 'member';
export type ConsentState = 'granted' | 'withdrawn';
export type ConsentSource = 'form' | 'paper' | 'email' | 'phone' | 'in_person' | 'import' | 'api' | 'erasure';
export type ErasureReason = 'subject_request' | 'consent_withdrawn' | 'other';

export interface ConsentEvent {
  purpose: string;
  state: ConsentState;
  source: ConsentSource;
  recordedBy: string;
  recordedAt: string;
}

export interface ErasureRow {
  id: string;
  subjectKind: SubjectKind;
  subjectId: string;
  reason: ErasureReason;
  summary: unknown;
  requestedBy: string;
  completedAt: string;
}

/** A record as stored: sensitive values sealed. */
export interface StoredRecord {
  id: string;
  typeKey: string;
  number: string | null;
  data: Record<string, unknown>;
}

export interface FinancialRows {
  receipts: number;
  journalEntries: number;
  paymentIntents: number;
  /** The latest receipt or journal date among them, `YYYY-MM-DD`. */
  latestDate: string | null;
}

/** Rows changed beside the records, by kind (`apiResponses`, `events`, `jobItems`, `paymentEvents`, …). */
export type SideData = Record<string, number>;

/** Consent history and erasure in the organisation the transaction is open for. */
export interface PrivacyStore {
  /** Holds until the transaction ends, so two erasures of one subject run one after the other. */
  lockSubject(tx: Tx, kind: SubjectKind, subjectId: string): Promise<void>;
  addConsent(tx: Tx, e: { kind: SubjectKind; subjectId: string; purpose: string; state: ConsentState; source: ConsentSource; actorId: string }): Promise<ConsentEvent>;
  /** Oldest first. */
  consentHistory(tx: Tx, kind: SubjectKind, subjectId: string): Promise<ConsentEvent[]>;

  erasure(tx: Tx, kind: SubjectKind, subjectId: string): Promise<ErasureRow | undefined>;
  addErasure(tx: Tx, row: Omit<ErasureRow, 'completedAt'>): Promise<ErasureRow>;

  /** The record, live or deleted, locked for update. */
  record(tx: Tx, id: string): Promise<StoredRecord | undefined>;
  /** Records of `typeKey`, live or deleted, whose `field` holds `value`, locked for update. */
  recordsWhere(tx: Tx, typeKey: string, field: string, value: string): Promise<StoredRecord[]>;
  /** Stores new data, keyed hashes and search text, and counts a new version. */
  rewriteRecord(tx: Tx, id: string, next: { data: Record<string, unknown>; blindIndex: Record<string, string>; searchText: string; actorId: string }): Promise<void>;
  /** Files attached to these fields of the record are detached and renamed, so the regular clean-up removes them; returns their ids. */
  detachFiles(tx: Tx, recordId: string, fieldKeys: string[]): Promise<string[]>;
  /** Replaces the values of `keys` in the record's audit snapshots; returns the entries changed. */
  eraseAuditValues(tx: Tx, typeKey: string, recordId: string, keys: string[]): Promise<number>;
  /** Clears the address, subject and body of messages about these records. */
  eraseNotifications(tx: Tx, recordIds: string[]): Promise<number>;
  /**
   * Clears the subject's values kept beside the records this erasure
   * pseudonymised (stored responses, events, import rows, approvals, delivery
   * errors, script messages, payment webhook bodies, file and member audit
   * entries, the member's own messages); returns how many rows changed per kind.
   */
  eraseSideData(tx: Tx, e: { erasureId: string; records: { id: string; fields: string[] }[]; memberId: string | null; fileIds: string[] }): Promise<SideData>;
  financialRows(tx: Tx, recordIds: string[]): Promise<FinancialRows>;

  memberStatus(tx: Tx, userId: string): Promise<'active' | 'suspended' | undefined>;
  /** `shared` when the account also belongs to another organisation and was left unchanged. */
  eraseAccount(tx: Tx, userId: string, name: string, email: string): Promise<'erased' | 'shared'>;

  audit(tx: Tx, e: { actorId: string; action: string; entity: string; entityId: string; after: unknown }): Promise<void>;
}
