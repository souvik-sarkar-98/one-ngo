import type { Tx } from '../../ports/transaction.js';

/** The money account a statement belongs to, with the ledger account its balance comes from. */
export interface ReconAccount {
  id: string;
  key: string;
  name: string;
  ledgerAccountId: string;
  ledgerCode: string;
  status: 'active' | 'closed';
}

export type StatementLineStatus = 'unmatched' | 'matched' | 'ignored';

/** One line of the bank's statement. Money in is positive, money out negative. Dates are `YYYY-MM-DD`. */
export interface StatementLine {
  id: string;
  date: string;
  amount: string;
  description: string;
  reference: string | null;
  status: StatementLineStatus;
  /** The ledger line this statement line is the other half of, when matched. */
  journalLineId: string | null;
  note: string | null;
}

export interface NewStatementLine {
  date: string;
  amount: string;
  description: string;
  reference: string | null;
  fingerprint: string;
}

/** A line of the books on the account's ledger account. `amount` is debit less credit: money in is positive. */
export interface BookLine {
  id: string;
  entryId: string;
  date: string;
  memo: string | null;
  amount: string;
}

export interface SignOff {
  id: string;
  asOf: string;
  statementBalance: string;
  bookBalance: string;
  outstandingBook: string;
  note: string | null;
  signedOffBy: string;
  signedOffAt: string;
}

export interface NewSignOff {
  asOf: string;
  statementBalance: string;
  bookBalance: string;
  outstandingBook: string;
  note: string | null;
}

/** Persistence for statement lines and reconciliation sign-offs. Writes are audited with the change. */
export interface BankReconciliationStore {
  account(tx: Tx, key: string): Promise<ReconAccount | undefined>;
  /** Adds the lines whose fingerprint is new for the account; returns how many were added. */
  addLines(tx: Tx, actorId: string, accountId: string, lines: NewStatementLine[]): Promise<number>;
  /** Which of these fingerprints the account already holds. */
  existingFingerprints(tx: Tx, accountId: string, fingerprints: string[]): Promise<Set<string>>;
  lines(tx: Tx, accountId: string, filter: { status?: StatementLineStatus; limit: number }): Promise<StatementLine[]>;
  /** Locks and returns one line of the account. */
  lockLine(tx: Tx, accountId: string, lineId: string): Promise<StatementLine | undefined>;
  setLine(tx: Tx, actorId: string, lineId: string, change: { status: StatementLineStatus; journalLineId: string | null; note: string | null }): Promise<void>;
  /** Ledger lines on the account that no statement line has taken, oldest first. `from` and `to` are inclusive. */
  openBookLines(tx: Tx, ledgerAccountId: string, range: { from?: string; to?: string }): Promise<BookLine[]>;
  /** One ledger line on the account, whether or not a statement line has taken it. */
  bookLine(tx: Tx, ledgerAccountId: string, journalLineId: string): Promise<(BookLine & { taken: boolean }) | undefined>;
  /** The ledger line of this entry that sits on the account. */
  entryLineOn(tx: Tx, entryId: string, ledgerAccountId: string): Promise<string | undefined>;
  /** Debits less credits on the ledger account for entries dated on or before `asOf`. */
  bookBalance(tx: Tx, ledgerAccountId: string, asOf: string): Promise<string>;
  /** The newest sign-off for the account. */
  lastSignOff(tx: Tx, accountId: string): Promise<SignOff | undefined>;
  signOffs(tx: Tx, accountId: string): Promise<SignOff[]>;
  addSignOff(tx: Tx, actorId: string, accountId: string, signOff: NewSignOff): Promise<SignOff>;
}
