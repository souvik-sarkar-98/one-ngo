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

/** A deleted record as the recycle bin lists it. */
export interface DeletedRecord {
  id: string;
  type: string;
  typeLabel: string;
  number: string | null;
  /** The record's title field, masked as the person may see it; null when the type has none. */
  title: string | null;
  version: number;
  deletedAt: string;
  deletedBy: string | null;
  deletedByName: string | null;
}

/** One page of the recycle bin, with how many deleted records match. */
export interface DeletedPage {
  items: DeletedRecord[];
  total: number;
}
