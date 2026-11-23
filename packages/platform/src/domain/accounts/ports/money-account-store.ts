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
