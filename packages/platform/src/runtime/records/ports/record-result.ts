import type { Receipt } from '../../../domain/receipts/receipt-service.js';
import type { PersonRef } from '../person-fields.js';
import type { RecordRef } from '../reference-fields.js';

/** A record as the engine hands it out. */
export interface RecordView {
  id: string;
  type: string;
  number: string | null;
  status: string | null;
  version: number;
  schemaVersion: number;
  data: Record<string, unknown>;
  /** The primary workflow the record follows. */
  workflow: string | null;
  /** States of parallel workflows that have started, by workflow key. */
  states: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  /** Person fields holding a member, by field key, with the member's name. */
  people?: Record<string, PersonRef>;
  /** Reference fields holding a readable record, by field key, with that record's label. */
  references?: Record<string, RecordRef>;
  /** Set on restricted records the person may share: they created it or hold record:<type>:share. */
  canShare?: true;
}

/** What a record save returns. */
export interface SaveResult {
  record: RecordView;
  receipts: Receipt[];
  journalEntryIds: string[];
  /** Set when the step needs approval; the record is unchanged until it is approved. */
  approvalRequestId?: string;
}

/** Engine-internal options; never populated from a request body. */
export interface InternalTransitionOptions {
  approvedRequestId?: string;
}
