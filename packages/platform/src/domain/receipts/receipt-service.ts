import type { Actor } from '../ports/tenant-context.js';
import { notFound, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import type { Tx } from '../ports/transaction.js';
import { fiscalYearKey, numberingPeriod } from '../ledger/fiscal-year.js';
import { paiseToDecimal, toPaise } from '../money.js';
import type { IssuerSnapshot } from '../organisations/organisation.js';
import type { ReceiptContent } from './receipt-content.js';
import type { IssuerSource, Receipt, ReceiptSeries, ReceiptStore } from './ports/receipt-store.js';

export type { Receipt } from './ports/receipt-store.js';
export type { ReceiptContent } from './receipt-content.js';

/** The number, amount and issuer a layout is filled from, once the number is known. */
export interface IssuedReceiptFacts {
  number: string;
  amount: string;
  date: string;
  series: ReceiptSeries;
  issuer: IssuerSnapshot;
}

export interface IssueReceiptInput {
  seriesKey: string;
  date: string;
  amount: number | string;
  recordId?: string | null;
  /** Fills the wording after the number is known. Used when `content` is omitted. */
  wording?: (facts: IssuedReceiptFacts) => ReceiptContent;
  /**
   * Wording to keep as given. `null` keeps none, which a replacement uses when
   * the voided receipt predates layouts. Omitted wording is filled from `wording`.
   */
  content?: ReceiptContent | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A receipt carries the issuer's legal name and registered address, so the
 * organisation must have both before one can be numbered. This is the same
 * identity the setup checklist asks for; receipts already issued are untouched.
 */
const IDENTITY_INCOMPLETE = 'Add the organisation’s legal name and registered address in Administration → Organisation identity before issuing a receipt.';
const IDENTITY_INCOMPLETE_KEY = 'ui.records.receiptIdentityIncomplete';

const identityComplete = (issuer: IssuerSnapshot) => !!issuer.legalName?.trim() && !!issuer.address;

/**
 * Numbered receipts. Numbers are gap-free per series and period, are never
 * reused, and survive voiding. A replacement gets a new number linked to the
 * voided receipt.
 */
export class ReceiptService {
  constructor(
    private readonly store: ReceiptStore,
    private readonly issuers: IssuerSource,
  ) {}

  async issue(tx: Tx, actor: Actor, input: IssueReceiptInput, replaces?: string): Promise<Receipt> {
    const paise = toPaise(input.amount, 'Receipt amount');
    if (paise <= 0) throw ruleViolation('Receipt amount must be more than zero.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw validationFailed('Receipt date must be an ISO date.');

    const issuer = await this.issuers.snapshot(tx, input.date);
    if (!identityComplete(issuer)) throw ruleViolation(IDENTITY_INCOMPLETE, IDENTITY_INCOMPLETE_KEY);

    const series = await this.store.series(tx, input.seriesKey);
    if (!series) throw ruleViolation(`Receipt series '${input.seriesKey}' does not exist.`);

    await this.store.holdFiscalYearStart(tx);
    // The period label is numberingPeriod's; the year is only worked out (one more read) when the series restarts yearly.
    const yearly = series.reset !== 'never';
    const period = numberingPeriod(yearly ? 'fiscal_year' : 'never', yearly ? fiscalYearKey(input.date, await this.store.fiscalYearStartMonth(tx)) : '');
    const seq = await this.store.nextNumber(tx, `receipt:${input.seriesKey}`, period);
    const number =
      series.reset === 'never'
        ? `${series.prefix}/${String(seq).padStart(5, '0')}`
        : `${series.prefix}/${period}/${String(seq).padStart(5, '0')}`;
    const amount = paiseToDecimal(paise);
    const content =
      input.content !== undefined ? input.content : input.wording ? input.wording({ number, amount, date: input.date, series, issuer }) : undefined;

    return this.store.insert(tx, actor.id, {
      seriesKey: input.seriesKey,
      period,
      seq,
      number,
      recordId: input.recordId ?? null,
      amount,
      date: input.date,
      replacesReceiptId: replaces ?? null,
      issuer,
      content,
    });
  }

  /**
   * Makes the next receipt of a series in the period holding `date` number at least `next`,
   * so receipts issued before this system are not numbered again. Never lowers the counter.
   * Returns the series, the period and the number the next receipt will take.
   */
  async continueNumbering(tx: Tx, seriesKey: string, date: string, next: number): Promise<{ series: ReceiptSeries; period: string; next: number }> {
    if (!Number.isInteger(next) || next < 1) throw validationFailed('The next receipt number must be a whole number of at least 1.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw validationFailed('The date must be an ISO date.');
    const series = await this.store.series(tx, seriesKey);
    if (!series) throw ruleViolation(`Receipt series '${seriesKey}' does not exist.`);
    await this.store.holdFiscalYearStart(tx);
    const yearly = series.reset !== 'never';
    const period = numberingPeriod(yearly ? 'fiscal_year' : 'never', yearly ? fiscalYearKey(date, await this.store.fiscalYearStartMonth(tx)) : '');
    return { series, period, next: await this.store.raiseNumber(tx, `receipt:${seriesKey}`, period, next) };
  }

  async void(tx: Tx, actor: Actor, receiptId: string, reason: string): Promise<Receipt> {
    if (!reason?.trim()) throw validationFailed('A reason is required to void a receipt.');
    const voided = await this.store.void(tx, actor.id, receiptId, reason.trim());
    if (!voided) {
      if (!(await this.store.exists(tx, receiptId))) throw notFound('Receipt not found.');
      throw ruleViolation('This receipt is already void.');
    }
    return voided;
  }

  /** Voids `receiptId` and issues a replacement linked to it, in the caller's transaction. */
  async replace(
    tx: Tx,
    actor: Actor,
    receiptId: string,
    reason: string,
    changes: { amount?: number | string; date?: string } = {},
  ): Promise<{ voided: Receipt; replacement: Receipt }> {
    const voided = await this.void(tx, actor, receiptId, reason);
    const kept = await this.store.content(tx, voided.id);
    const replacement = await this.issue(
      tx,
      actor,
      {
        seriesKey: voided.seriesKey,
        date: changes.date ?? voided.date,
        amount: changes.amount ?? voided.amount,
        recordId: voided.recordId,
        content: kept ?? null,
      },
      voided.id,
    );
    return { voided, replacement };
  }

  async get(tx: Tx, receiptId: string): Promise<Receipt | undefined> {
    if (!UUID.test(receiptId)) return undefined;
    return this.store.get(tx, receiptId);
  }

  /** The issuer kept when the receipt was issued; receipts issued before snapshots were kept have none. */
  async issuer(tx: Tx, receiptId: string): Promise<IssuerSnapshot | undefined> {
    return this.store.issuer(tx, receiptId);
  }

  /** Wording kept when the receipt was issued. Absent on receipts issued before layouts. */
  async content(tx: Tx, receiptId: string): Promise<ReceiptContent | undefined> {
    return this.store.content(tx, receiptId);
  }

  /** The organisation's issuer details as they apply on `onDate`. */
  async currentIssuer(tx: Tx, onDate: string): Promise<IssuerSnapshot> {
    return this.issuers.snapshot(tx, onDate);
  }

  async series(tx: Tx, key: string): Promise<ReceiptSeries | undefined> {
    return this.store.series(tx, key);
  }

  async forRecord(tx: Tx, recordId: string): Promise<Receipt[]> {
    return this.store.forRecord(tx, recordId);
  }
}
