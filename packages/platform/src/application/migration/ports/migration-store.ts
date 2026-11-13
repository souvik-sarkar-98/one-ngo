import type { Tx } from '../../../domain/ports/transaction.js';
import type { BooksInput, BooksResult, MigrationCheck, MigrationColumn, ProfileStatus } from '../migration-service.js';
import type { SourceMapping } from '../mapping.js';

export interface ProfileRow {
  id: string;
  name: string;
  status: ProfileStatus;
  books: BooksInput;
  books_applied_at: string | Date | null;
  books_result: BooksResult | null;
  check_result: MigrationCheck | null;
  job_id: string | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface SourceRow {
  id: string;
  profile_id: string;
  file_id: string;
  file_name: string;
  columns: MigrationColumn[];
  row_count: number;
  position: number;
  mapping: SourceMapping | null;
}

export interface NewSource {
  profileId: string;
  fileId: string;
  fileName: string;
  columns: MigrationColumn[];
  rowCount: number;
}

/** The record an old id became, with its version for the next update. */
export interface KeyedRecord {
  recordId: string;
  version: number;
}

export interface SourceCounts {
  created: number;
  updated: number;
  failed: number;
}

/** The organisation's data migrations, in the open transaction. */
export interface MigrationStore {
  addProfile(tx: Tx, p: { name: string; createdBy: string }): Promise<ProfileRow>;
  /** Newest first. */
  profiles(tx: Tx, limit: number): Promise<ProfileRow[]>;
  profile(tx: Tx, id: string): Promise<ProfileRow | undefined>;
  /** A profile's files, in load order. */
  sources(tx: Tx, profileId: string): Promise<SourceRow[]>;
  /** Adds the file last; undefined when the profile already has a file of that name. */
  addSource(tx: Tx, s: NewSource): Promise<SourceRow | undefined>;
  removeSource(tx: Tx, profileId: string, sourceId: string): Promise<boolean>;
  saveMapping(tx: Tx, profileId: string, sourceId: string, mapping: SourceMapping): Promise<boolean>;
  /** Positions follow `sourceIds`, which lists every file of the profile. */
  setOrder(tx: Tx, profileId: string, sourceIds: string[]): Promise<void>;
  saveBooks(tx: Tx, profileId: string, books: BooksInput): Promise<void>;
  /** Back to draft with no check, unless the profile is running; false then. */
  reset(tx: Tx, profileId: string): Promise<boolean>;
  saveCheck(tx: Tx, profileId: string, check: MigrationCheck): Promise<void>;
  /** Marks a checked profile running; false when it was not checked. */
  claim(tx: Tx, profileId: string): Promise<boolean>;
  setJob(tx: Tx, profileId: string, jobId: string): Promise<void>;
  setStatus(tx: Tx, profileId: string, status: ProfileStatus): Promise<void>;
  /** Records what applying the books did; `applied` false keeps them unapplied (it failed). */
  saveBooksResult(tx: Tx, profileId: string, result: BooksResult, applied: boolean): Promise<void>;
  /** Locks the profile row for the rest of the transaction, so the books apply once. */
  lockProfile(tx: Tx, profileId: string): Promise<ProfileRow | undefined>;
  /** The live records the given old ids of a record type became. */
  keys(tx: Tx, typeKey: string, oldIds: string[]): Promise<Map<string, KeyedRecord>>;
  /** Remembers which record an old id became, replacing an earlier one. */
  putKey(tx: Tx, k: { typeKey: string; oldId: string; recordId: string; profileId: string }): Promise<void>;
  /** Up to `limit` failed rows of one file after job item `after`, in order. */
  failedRows(tx: Tx, jobId: string, sourceId: string, after: number, limit: number): Promise<{ seq: number; message: string | null; data: { cells?: string[] } | null }[]>;
  /** Records created and updated, and rows failed, per file. */
  counts(tx: Tx, jobId: string): Promise<Map<string, SourceCounts>>;
}
