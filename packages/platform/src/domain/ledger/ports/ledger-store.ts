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
  /** Set when the entry takes a money account below zero on purpose: the reason and the accounts, for the audit trail. */
  overdraft?: { reason: string; accounts: { code: string; before: string; after: string }[] };
}

/** A money account's ledger account with what it holds now, read with its row locked. */
export interface MoneyAccountBalance {
  accountId: string;
  code: string;
  name: string;
  /** Debits less credits over every posted line, as a decimal. */
  balance: string;
  allowNegative: boolean;
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
  /**
   * Which of the ledger accounts are money accounts, and what each holds now. The money account rows are
   * locked until the transaction ends, so two postings cannot both spend the same balance.
   */
  lockMoneyBalances(tx: Tx, accountIds: string[]): Promise<MoneyAccountBalance[]>;
  /** Writes the entry and its lines; returns the entry id. */
  insertEntry(tx: Tx, actorId: string, entry: NewJournalEntry): Promise<string>;
  entryStatus(tx: Tx, entryId: string): Promise<string | undefined>;
  entryLines(tx: Tx, entryId: string): Promise<PostedLine[]>;
  markReversed(tx: Tx, entryId: string): Promise<void>;
  trialBalance(tx: Tx, fiscalYear: string): Promise<TrialBalanceRow[]>;
  /**
   * Debits and credits of every ledger account up to `asOf`. Assets, liabilities and equity count every entry
   * since the books began, because they carry forward; income and expenses count only entries on or after
   * `yearStart`, because they start again each financial year.
   */
  balancesAsOn(tx: Tx, range: { asOf: string; yearStart: string }): Promise<AsOnRow[]>;
}

export interface AsOnRow {
  code: string;
  name: string;
  type: string;
  active: boolean;
  /** The money account this ledger account belongs to, if any. */
  moneyKey: string | null;
  /** For money, debts and funds: everything up to the date. For income and expenses: the current financial year only. */
  debit: string;
  credit: string;
  /** Income and expenses from financial years before the current one, which the trial balance rolls into one surplus line. */
  priorDebit: string;
  priorCredit: string;
}
