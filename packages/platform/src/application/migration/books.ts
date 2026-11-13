import { PlatformError, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { LedgerService } from '../../domain/ledger/ledger-service.js';
import { paiseToDecimal, toPaise } from '../../domain/money.js';
import type { Actor } from '../../domain/ports/tenant-context.js';
import type { Tx } from '../../domain/ports/transaction.js';
import type { ReceiptService } from '../../domain/receipts/receipt-service.js';

export const MAX_BOOK_LINES = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One line of the opening journal: a debit or a credit, as a decimal string of rupees. */
export interface BooksLine {
  accountCode: string;
  debit?: string;
  credit?: string;
}

/** Where numbering continues: the next receipt a series issues in the cutover period. */
export interface BooksReceipt {
  series: string;
  next: number;
}

/** Balances and numbering at the cutover date, applied once after every file has loaded. */
export interface BooksInput {
  cutoverDate?: string;
  lines?: BooksLine[];
  receipts?: BooksReceipt[];
}

export interface BooksResult {
  journalEntryId?: string;
  receipts?: { series: string; period: string; next: number }[];
  /** Why applying them failed; the books stay unapplied. */
  error?: string;
}

export const hasBooks = (b: BooksInput | null | undefined): boolean => !!(b?.lines?.length || b?.receipts?.length);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Books as a person sent them, checked and in their stored shape. The opening journal must balance. */
export function readBooks(input: unknown): BooksInput {
  if (!isObject(input)) throw validationFailed('Send the books as an object.');
  const issues: FieldIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const out: BooksInput = {};

  const date = typeof input.cutoverDate === 'string' ? input.cutoverDate.trim() : '';
  if (date) {
    if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) add('/cutoverDate', 'must be a date written yyyy-mm-dd');
    else out.cutoverDate = date;
  }

  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length > MAX_BOOK_LINES) add('/lines', `can have at most ${MAX_BOOK_LINES} lines`);
  let debit = 0;
  let credit = 0;
  const kept: BooksLine[] = [];
  for (const [i, l] of lines.slice(0, MAX_BOOK_LINES).entries()) {
    const at = `/lines/${i}`;
    if (!isObject(l)) {
      add(at, 'must be an object');
      continue;
    }
    const accountCode = typeof l.accountCode === 'string' ? l.accountCode.trim() : '';
    if (!accountCode) add(`${at}/accountCode`, 'choose a ledger account');
    const amount = (key: 'debit' | 'credit') => {
      const v = l[key];
      if (v === undefined || v === null || v === '') return 0;
      try {
        const p = toPaise(v, key === 'debit' ? 'Debit' : 'Credit');
        if (p < 0) add(`${at}/${key}`, 'cannot be negative');
        return p;
      } catch (e) {
        if (!(e instanceof PlatformError)) throw e;
        add(`${at}/${key}`, e.message);
        return 0;
      }
    };
    const d = amount('debit');
    const c = amount('credit');
    if ((d === 0) === (c === 0)) add(at, 'enter either a debit or a credit');
    debit += Math.max(d, 0);
    credit += Math.max(c, 0);
    kept.push({ accountCode, ...(d > 0 ? { debit: paiseToDecimal(d) } : {}), ...(c > 0 ? { credit: paiseToDecimal(c) } : {}) });
  }
  if (kept.length === 1) add('/lines', 'an opening journal needs at least two lines');
  if (kept.length && debit !== credit) add('/lines', `debits ${paiseToDecimal(debit)} and credits ${paiseToDecimal(credit)} must be equal`);
  if (kept.length) out.lines = kept;

  const receipts = Array.isArray(input.receipts) ? input.receipts : [];
  const seen = new Set<string>();
  const keptReceipts: BooksReceipt[] = [];
  for (const [i, r] of receipts.entries()) {
    const at = `/receipts/${i}`;
    if (!isObject(r)) {
      add(at, 'must be an object');
      continue;
    }
    const series = typeof r.series === 'string' ? r.series.trim() : '';
    const next = typeof r.next === 'string' ? Number(r.next) : r.next;
    if (!series) add(`${at}/series`, 'choose a receipt series');
    else if (seen.has(series)) add(`${at}/series`, `'${series}' is listed twice`);
    if (typeof next !== 'number' || !Number.isInteger(next) || next < 1) add(`${at}/next`, 'must be a whole number of at least 1');
    seen.add(series);
    keptReceipts.push({ series, next: next as number });
  }
  if (keptReceipts.length) out.receipts = keptReceipts;

  if ((out.lines || out.receipts) && !out.cutoverDate && !issues.some((i) => i.path === '/cutoverDate')) add('/cutoverDate', 'enter the cutover date');
  if (issues.length) throw validationFailed('These books cannot be saved.', issues);
  return out;
}

/**
 * Posts the opening journal and continues receipt numbering, in the caller's transaction, so
 * either all of it applies or none. The ledger's own checks still apply: the accounts must exist
 * and be active, and the financial year holding the cutover date must be open.
 */
export async function applyBooks(
  tx: Tx,
  actor: Actor,
  books: BooksInput,
  ledger: Pick<LedgerService, 'post'>,
  receipts: Pick<ReceiptService, 'continueNumbering'>,
): Promise<BooksResult> {
  const date = books.cutoverDate!;
  const out: BooksResult = {};
  if (books.lines?.length) {
    out.journalEntryId = await ledger.post(tx, actor, { date, memo: 'Opening balances (data migration)', lines: books.lines });
  }
  if (books.receipts?.length) {
    out.receipts = [];
    for (const r of books.receipts) {
      const done = await receipts.continueNumbering(tx, r.series, date, r.next);
      out.receipts.push({ series: r.series, period: done.period, next: done.next });
    }
  }
  return out;
}
