import type { Tx } from '../../ports/transaction.js';

/** A receipt's public link as stored. The token is kept encrypted so an authorised member can copy it again. */
export interface StoredLink {
  tokenEnc: string;
  revoked: boolean;
}

/** The stored file behind a receipt's logo or signature, read inside the receipt's tenant. */
export interface ReceiptImageRecord {
  name: string;
  mime: string;
  size: number;
  storageKey: string;
  storeRef: string;
}

/** The record a receipt was issued for, as far as a public receipt reads it. */
export interface ReceiptRecordRow {
  typeKey: string;
  number: string | null;
  data: unknown;
}

/** Storage for receipt public links and the rows a public receipt reads. */
export interface ReceiptLinkStore {
  /** The tenant and receipt a live token opens. Looked up by hash, without a signed-in person. */
  findLive(tokenHash: string): Promise<{ tenantId: string; receiptId: string } | null>;
  /** The link for a receipt, live or revoked. */
  link(tx: Tx, receiptId: string): Promise<StoredLink | undefined>;
  /** Creates the link, or replaces a revoked one with a new token. */
  saveLink(tx: Tx, link: { receiptId: string; exists: boolean; tokenHash: string; tokenEnc: string; actorId: string }): Promise<void>;
  /** Revokes the live link. False when there is none. */
  revokeLink(tx: Tx, receiptId: string, actorId: string): Promise<boolean>;
  /** A live file of this tenant. */
  file(tx: Tx, fileId: string): Promise<ReceiptImageRecord | undefined>;
  /** A live record of this tenant. */
  record(tx: Tx, recordId: string): Promise<ReceiptRecordRow | undefined>;
}
