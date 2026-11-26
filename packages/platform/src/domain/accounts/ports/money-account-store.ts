import type { Tx } from '../../ports/transaction.js';

export type MoneyAccountKind = 'bank' | 'cash' | 'wallet' | 'investment';

export interface MoneyAccount {
  id: string;
  key: string;
  name: string;
  kind: MoneyAccountKind;
  ledgerCode: string;
  holderUserId: string | null;
  custodian: string | null;
  upiId: string | null;
  allowNegative: boolean;
  status: 'active' | 'closed';
  /** Posted journal lines on the account's ledger account, debits less credits. */
  balance: string;
}

/** A money account with what its ledger account holds on one date. */
export interface AccountBalance {
  key: string;
  name: string;
  kind: MoneyAccountKind;
  ledgerCode: string;
  balance: string;
}

/** Where an entry on an account's ledger came from. */
export type LedgerLineKind = 'record' | 'transfer' | 'reversal' | 'manual';

/** One line of an account's ledger: money in is a debit, money out a credit. `balance` runs on from the opening balance. */
export interface LedgerStatementLine {
  id: string;
  entryId: string;
  date: string;
  memo: string | null;
  debit: string;
  credit: string;
  balance: string;
  kind: LedgerLineKind;
  /** The entry has been undone by a reversal. */
  reversed: boolean;
  sourceRecordId: string | null;
  sourceRecordType: string | null;
  sourceRecordNumber: string | null;
}

/** A page of an account's ledger between two dates, with the totals of the whole range. */
export interface LedgerStatementPage {
  opening: string;
  totalIn: string;
  totalOut: string;
  closing: string;
  count: number;
  lines: LedgerStatementLine[];
}

/** A ledger account, with the money account that uses it, if any. */
export interface LedgerAccountSummary {
  code: string;
  name: string;
  type: string;
  active: boolean;
  moneyKey: string | null;
}

/** A ledger account that a money account may attach to. */
export interface LedgerAccountRef {
  id: string;
  type: string;
  active: boolean;
  /** True when a money account already uses this ledger account. */
  linked: boolean;
}

export interface NewMoneyAccount {
  key: string;
  name: string;
  kind: MoneyAccountKind;
  ledgerCode: string;
  /** Set when attaching to an existing ledger account; otherwise a new one is created. */
  ledgerAccountId?: string;
  holderUserId: string | null;
  custodian: string | null;
  upiId: string | null;
  allowNegative: boolean;
}

export interface MoneyAccountChange {
  name?: string;
  custodian?: string | null;
  upiId?: string | null;
  allowNegative?: boolean;
}

export interface NewTransfer {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  date: string;
  reference: string | null;
  journalEntryId: string;
}

/** Money-account persistence. Writes are audited with the change. */
export interface MoneyAccountStore {
  /** Adds the account, creating its asset ledger account unless `ledgerAccountId` is given; false when a new ledger account's code already exists. */
  open(tx: Tx, actorId: string, account: NewMoneyAccount, audit: unknown): Promise<boolean>;
  /** The ledger account with this code, if any. */
  ledgerAccount(tx: Tx, code: string): Promise<LedgerAccountRef | undefined>;
  /** Changes the given fields of an active account; `null` clears a nullable one. Returns false when the account is missing. */
  update(tx: Tx, actorId: string, key: string, change: MoneyAccountChange, audit: unknown): Promise<boolean>;
  list(tx: Tx): Promise<MoneyAccount[]>;
  byKey(tx: Tx, key: string): Promise<MoneyAccount | undefined>;
  /** Active accounts with their balance on `asOf` (entries dated on or before it). */
  balancesAsOf(tx: Tx, asOf: string): Promise<AccountBalance[]>;
  /** The account's ledger lines dated from `from` to `to`, oldest first, one page of them, with the totals of the whole range. */
  ledgerStatement(tx: Tx, key: string, range: { from: string; to: string }, page: { limit: number; offset: number }): Promise<LedgerStatementPage>;
  /** Every ledger account, by code. */
  ledgerAccounts(tx: Tx): Promise<LedgerAccountSummary[]>;
  /** Locks the accounts in a stable order until the transaction ends; returns how many were found. */
  lock(tx: Tx, keys: string[]): Promise<number>;
  /** The allowed [from, to] kind pairs; undefined when every pair is allowed. */
  /** The transfer matrix kept in the organisation setting settingKey (TRANSFER_MATRIX_SETTING). */
  transferMatrix(tx: Tx, settingKey: string): Promise<[string, string][] | undefined>;
  /** Records a transfer already posted to the ledger; returns its id. */
  recordTransfer(tx: Tx, actorId: string, transfer: NewTransfer, audit: { from: string; to: string }): Promise<string>;
  /** Closes the account and deactivates its ledger account. */
  close(tx: Tx, actorId: string, key: string, ledgerCode: string): Promise<void>;
}
