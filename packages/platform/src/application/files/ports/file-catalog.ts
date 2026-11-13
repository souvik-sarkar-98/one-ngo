import type { Tx } from '../../../domain/ports/transaction.js';

export interface FileRow {
  id: string;
  name: string;
  mime: string;
  size: string | number;
  storage_key: string;
  /** The store that holds the bytes (`platform` for the installation's one store). */
  store_ref: string;
  record_id: string | null;
  field_key: string | null;
  created_by: string;
  created_at: string | Date;
}

export interface NewFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  storageKey: string;
  storeRef: string;
  createdBy: string;
}

/** The organisation's stored files (their rows, not their bytes) in the open transaction. */
export interface FileCatalog {
  /** Bytes held by files that are not removed. */
  usedBytes(tx: Tx): Promise<number>;
  /** Bytes used, and the stored value of the quota setting (null when unset). */
  usage(tx: Tx, quotaSetting: string): Promise<{ used: number; quota: unknown }>;
  add(tx: Tx, file: NewFile): Promise<FileRow>;
  /** A file that is not removed. */
  file(tx: Tx, id: string): Promise<FileRow | undefined>;
  /** Names of the files among `ids` that are not removed. */
  names(tx: Tx, ids: string[]): Promise<{ id: string; name: string }[]>;
  /**
   * Marks removed up to `limit` files never linked to a record for longer than
   * `unlinkedHours`, oldest first, except those an unfinished import reads, the
   * files of a data migration, the organisation's assets and receipt logos.
   * Returns where their bytes are.
   */
  removeUnlinked(tx: Tx, unlinkedHours: number, limit: number): Promise<{ id: string; storage_key: string; store_ref: string }[]>;
}
