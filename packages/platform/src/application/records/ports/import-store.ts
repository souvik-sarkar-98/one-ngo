import type { Tx } from '../../../domain/ports/transaction.js';
import type { CheckResult, ImportColumn, ImportMapping, ImportOptions, ImportStatus } from '../import-service.js';

export interface ImportRow {
  id: string;
  type_key: string;
  file_id: string;
  file_name: string;
  columns: ImportColumn[];
  row_count: number;
  mapping: ImportMapping | null;
  options: ImportOptions;
  status: ImportStatus;
  check_result: CheckResult | null;
  job_id: string | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface NewImport {
  typeKey: string;
  fileId: string;
  fileName: string;
  columns: ImportColumn[];
  rowCount: number;
  createdBy: string;
}

/** CSV imports of the organisation in the open transaction, and the rows their jobs saved. */
export interface ImportStore {
  add(tx: Tx, i: NewImport): Promise<ImportRow>;
  get(tx: Tx, id: string): Promise<ImportRow | undefined>;
  /** Saves the mapping and clears the check, unless the import has started; undefined then. */
  saveMapping(tx: Tx, id: string, mapping: ImportMapping, options: ImportOptions): Promise<ImportRow | undefined>;
  /** Saves the check result, unless the import has started. */
  saveCheck(tx: Tx, id: string, result: CheckResult): Promise<void>;
  /** Marks a mapped or checked import running; false when it had already started. */
  claim(tx: Tx, id: string): Promise<boolean>;
  setJob(tx: Tx, id: string, jobId: string): Promise<ImportRow | undefined>;
  setStatus(tx: Tx, id: string, status: ImportStatus): Promise<ImportRow | undefined>;
  /** Up to `limit` failed rows of the job after row `after`, in order. */
  failedRows(tx: Tx, jobId: string, after: number, limit: number): Promise<{ seq: number; message: string | null; data: { cells?: string[] } | null }[]>;
  counts(tx: Tx, jobId: string): Promise<{ created: number; updated: number; failed: number }>;
}
