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
  /** When the source files and failed-row data were deleted; null before. */
  purged_at: string | Date | null;
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
  /** When the file was deleted; null while it is still stored. */
  purged_at: string | Date | null;
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
  /** Rows that saved but have something to know (people: roles skipped for a suspended person). */
  warned?: number;
}

/** A person a legacy user id was linked to. */
export interface LinkedPerson {
  userId: string;
  /** Lowercased. */
  email: string;
}

/** A file uploaded to a profile, under a relative path, for a file column to name. */
export interface AttachmentInfo {
  id: string;
  path: string;
  fileId: string;
  size: number;
  mime: string;
  uploadedBy: string;
  /** The record the file is linked to; null while it is not linked. */
  recordId: string | null;
}

export interface AttachmentItem {
  id: string;
  path: string;
  size: number;
  mime: string;
  /** 1 when a record holds the file, else 0. */
  usedBy: number;
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
  /** The people the given legacy user ids became in this organisation, with the email they have now. */
  personKeys(tx: Tx, oldIds: string[]): Promise<Map<string, LinkedPerson>>;
  /** Which of the lowercased emails belong to members of this organisation, whatever their status. Reads this organisation only. */
  memberEmails(tx: Tx, emails: string[]): Promise<Set<string>>;
  /** Remembers which person a legacy user id became; an id already linked is never re-linked. */
  putPersonKey(tx: Tx, k: { oldId: string; userId: string; profileId: string }): Promise<void>;
  /** Up to `limit` failed rows of one file after job item `after`, in order. */
  failedRows(tx: Tx, jobId: string, sourceId: string, after: number, limit: number): Promise<{ seq: number; message: string | null; data: { cells?: string[] } | null }[]>;
  /** Records created and updated, and rows failed, per file. */
  counts(tx: Tx, jobId: string): Promise<Map<string, SourceCounts>>;
  /** Replaces a file's column list (used to blank samples). */
  setColumns(tx: Tx, profileId: string, sourceId: string, columns: MigrationColumn[]): Promise<void>;
  /** Stores the given columns (samples emptied) and stamps the file purged, unless it already is. */
  markSourcePurged(tx: Tx, profileId: string, sourceId: string, columns: MigrationColumn[]): Promise<void>;
  /** Stamps the profile purged, unless it already is; true when this call did it. */
  markProfilePurged(tx: Tx, profileId: string): Promise<boolean>;
  /** Blanks the given cell positions of one file's failed rows in a job; the rows and reasons stay. */
  blankFailedCells(tx: Tx, jobId: string, sourceId: string, positions: number[]): Promise<void>;
  /** Removes the cells of every failed row of a job. */
  clearFailedCells(tx: Tx, jobId: string): Promise<void>;
  /** Finished or failed profiles not purged, last changed more than `days` days ago. */
  expiredProfiles(tx: Tx, days: number, limit: number): Promise<ProfileRow[]>;
  /** How many attachments the profile holds and their total size. */
  attachmentTotals(tx: Tx, profileId: string): Promise<{ count: number; bytes: number }>;
  /** Adds an attachment; false when the profile already has one at that path, ignoring case. */
  addAttachment(tx: Tx, a: { profileId: string; path: string; fileId: string; size: number; uploadedBy: string }): Promise<boolean>;
  /** Attachments whose path contains `q` (ignoring case), by path; `total` ignores the page. */
  attachmentPage(tx: Tx, profileId: string, page: { q: string; limit: number; offset: number }): Promise<{ items: AttachmentItem[]; total: number }>;
  /** The attachments at the given lowercased paths whose file is still stored, keyed by lowercased path. */
  attachmentsByPath(tx: Tx, profileId: string, lowerPaths: string[]): Promise<Map<string, AttachmentInfo>>;
  /** The files of every attachment of the profile. */
  attachmentFileIds(tx: Tx, profileId: string): Promise<string[]>;
  /** Deletes one attachment row; its file id, or undefined when there is none. */
  removeAttachment(tx: Tx, profileId: string, attachmentId: string): Promise<string | undefined>;
  /** Deletes every attachment row of the profile; the file ids they held. */
  clearAttachments(tx: Tx, profileId: string): Promise<string[]>;
}
