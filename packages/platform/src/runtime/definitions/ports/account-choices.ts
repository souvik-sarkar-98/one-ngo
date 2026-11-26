import type { Tx } from '../../../domain/ports/transaction.js';

/** One option of a field that takes its choices from the organisation's data. */
export interface Choice {
  value: string;
  label: string;
}

/**
 * The options of fields with `choicesFrom`. They are read as the forms are served, not stored in the
 * definition, so opening or closing a money account changes the forms without a new version.
 */
export interface AccountChoices {
  /** Active money accounts: value is the ledger code, label the account's name. */
  moneyAccounts(tx: Tx): Promise<Choice[]>;
  /** The same accounts keyed by their own key (the value a payment action's `account` field holds), with those that have a UPI ID. */
  moneyAccountsByKey(tx: Tx, filter?: { upi?: boolean }): Promise<Choice[]>;
}
