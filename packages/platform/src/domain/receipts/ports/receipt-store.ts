import type { Tx } from '../../ports/transaction.js';
import type { FiscalYearSettings } from '../../ledger/ports/ledger-store.js';
import type { IssuerSnapshot } from '../../organisations/organisation.js';

export interface Receipt {
  id: string;
  number: string;
  seriesKey: string;
  period: string;
  amount: string;
  date: string;
  status: 'issued' | 'void';
  voidReason: string | null;
  replacesReceiptId: string | null;
  recordId: string | null;
}

export interface ReceiptSeries {
  key: string;
  label: string;
  prefix: string;
  reset: string;
}

/** The wording kept with a receipt. Every string is already filled in. */
export interface ReceiptContent {
  ruleKey: string;
  title: string;
  statement: string | null;
  rows: { label: string; value: string }[];
  clauses: string[];
  thanks: string;
}

export interface NewReceipt {
  seriesKey: string;
  period: string;
  seq: number;
  number: string;
  recordId: string | null;
  amount: string;
  date: string;
  replacesReceiptId: string | null;
  issuer: IssuerSnapshot;
  /** Wording resolved at issue. Null leaves the receipt without kept wording. */
  content?: ReceiptContent | null;
}

/**
 * Receipt persistence. Numbers come from a gap-free counter held until the
 * transaction ends; the database forbids reusing or changing an issued number.
 * Writes are audited with the change.
 */
export interface ReceiptStore extends FiscalYearSettings {
  series(tx: Tx, key: string): Promise<ReceiptSeries | undefined>;
  /** Takes the next number in `counter` for `period`. */
  nextNumber(tx: Tx, counter: string, period: string): Promise<number>;
  /** Makes the next number in `counter` for `period` at least `next`, never lower; returns the next number. */
  raiseNumber(tx: Tx, counter: string, period: string, next: number): Promise<number>;
  /** Writes the receipt and the issuer kept with it. */
  insert(tx: Tx, actorId: string, receipt: NewReceipt): Promise<Receipt>;
  /** Voids an issued receipt; undefined when it is not issued. */
  void(tx: Tx, actorId: string, receiptId: string, reason: string): Promise<Receipt | undefined>;
  exists(tx: Tx, receiptId: string): Promise<boolean>;
  get(tx: Tx, receiptId: string): Promise<Receipt | undefined>;
  issuer(tx: Tx, receiptId: string): Promise<IssuerSnapshot | undefined>;
  /** Wording kept when the receipt was issued. Absent on receipts issued before layouts. */
  content(tx: Tx, receiptId: string): Promise<ReceiptContent | undefined>;
  forRecord(tx: Tx, recordId: string): Promise<Receipt[]>;
}

/** The organisation's issuer details as they apply on a date. */
export interface IssuerSource {
  snapshot(tx: Tx, onDate: string): Promise<IssuerSnapshot>;
}
