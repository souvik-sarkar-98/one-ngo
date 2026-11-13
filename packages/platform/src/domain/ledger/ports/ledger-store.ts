import type { Tx } from '../../ports/transaction.js';

/** The organisation's financial-year start, read inside the caller's transaction. */
export interface FiscalYearSettings {
  /** Holds the start month so it cannot change until the transaction ends. */
  holdFiscalYearStart(tx: Tx): Promise<void>;
  fiscalYearStartMonth(tx: Tx): Promise<number>;
}

export interface LedgerAccountRef {
  id: string;
  code: string;
  active: boolean;
}

export interface PeriodRef {
  id: string;
  status: string;
}

export interface NewJournalEntry {
  periodId: string;
  date: string;
  memo: string | null;
  sourceRecordId: string | null;
  sourceRule: string | null;
  reversesEntryId: string | null;
  lines: { accountId: string; debit: string; credit: string; fund: string | null }[];
  /** Kept on the audit trail with the entry. */
  total: string;
}

export interface PostedLine {
  code: string;
  debit: string;
  credit: string;
  fund: string | null;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  debit: string;
  credit: string;
}

/**
 * Ledger persistence. Writes are audited with the change; the database
 * repeats the balance and closed-period checks.
 */
export interface LedgerStore extends FiscalYearSettings {
  /** Adds the period unless it exists. */
  openPeriod(tx: Tx, actorId: string, period: { key: string; startsOn: string; endsOn: string }): Promise<void>;
  /** False when there is no open period `key`. */
  closePeriod(tx: Tx, actorId: string, key: string): Promise<boolean>;
  /** False when there is no closed period `key`. */
  reopenPeriod(tx: Tx, actorId: string, key: string, reason: string): Promise<boolean>;
  accounts(tx: Tx, codes: string[]): Promise<LedgerAccountRef[]>;
  period(tx: Tx, key: string): Promise<PeriodRef | undefined>;
  /** Writes the entry and its lines; returns the entry id. */
  insertEntry(tx: Tx, actorId: string, entry: NewJournalEntry): Promise<string>;
  entryStatus(tx: Tx, entryId: string): Promise<string | undefined>;
  entryLines(tx: Tx, entryId: string): Promise<PostedLine[]>;
  markReversed(tx: Tx, entryId: string): Promise<void>;
  trialBalance(tx: Tx, fiscalYear: string): Promise<TrialBalanceRow[]>;
}
