import { sha256 } from '@onengo/kernel/crypto';
import { notFound, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import type { TenantContext } from '../ports/tenant-context.js';
import type { TransactionManager, Tx } from '../ports/transaction.js';
import type { LedgerService } from '../ledger/ledger-service.js';
import { demand } from '../permissions.js';
import { paiseToDecimal, toPaise } from '../money.js';
import type { MoneyAccountStore } from './ports/money-account-store.js';
import type {
  BankReconciliationStore,
  BookLine,
  NewStatementLine,
  ReconAccount,
  SignOff,
  StatementLine,
  StatementLineStatus,
} from './ports/bank-reconciliation-store.js';

export type { BookLine, SignOff, StatementLine, StatementLineStatus } from './ports/bank-reconciliation-store.js';

/** Importing a statement, matching its lines to the books, booking what is missing, and signing the result off. */
export const RECONCILE_PERMISSION = 'money:reconcile';

/** A statement line and a ledger line for the same event may be dated this many days apart. */
export const MATCH_WINDOW_DAYS = 3;
export const MAX_IMPORT_LINES = 1000;
const LIST_LIMIT = 2000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StatementLineInput {
  date: string;
  /** Rupees: positive for money in, negative for money out. */
  amount: number | string;
  description: string;
  /** The bank's own reference (UTR, cheque number), when the statement has one. */
  reference?: string;
}

export interface ImportResult {
  added: number;
  /** Lines the account already held; they were left as they are. */
  duplicates: number;
  /** Lines paired with a ledger line straight after the import. */
  matched: number;
}

export interface ReconciliationReport {
  asOf: string;
  statementBalance: string;
  /** What the ledger account holds on `asOf`. */
  bookBalance: string;
  /** Ledger lines the bank has not shown yet, and their total (money in less money out). */
  outstandingBook: { lines: BookLine[]; total: string };
  /** Statement lines no ledger line answers yet, and their total. Book or ignore them before signing off. */
  unbooked: { lines: StatementLine[]; total: string };
  /** The statement balance less what the books explain. Zero when they agree. */
  difference: string;
  reconciled: boolean;
  lastSignOff: SignOff | null;
}

export interface SignOffInput {
  asOf: string;
  statementBalance: number | string;
  note?: string;
}

export interface BookLineInput {
  /** The ledger account for the other side: for example BANK_CHARGES or INTEREST_INCOME. */
  accountCode: string;
  memo?: string;
}

function checkDate(value: string, label: string): string {
  const ok = typeof value === 'string' && ISO_DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!ok) throw validationFailed(`${label} must be a date like 2026-04-30.`);
  return value;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (a: string, b: string): number => Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
const sumPaise = (rows: { amount: string }[]): number => rows.reduce((total, r) => total + toPaise(r.amount), 0);
const squash = (text: string): string => text.trim().replace(/\s+/g, ' ');

/**
 * The step that keeps the books honest against the real bank. A statement line is
 * what the bank says happened; it is paired with the ledger line for the same event,
 * ignored with a reason, or booked, which posts the missing entry and pairs it.
 * A sign-off says that, on a date, the statement balance and the books agree.
 */
export class BankReconciliationService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: BankReconciliationStore,
    private readonly accounts: MoneyAccountStore,
    private readonly ledger: LedgerService,
  ) {}

  /** Adds the statement lines the account does not hold yet, then pairs what it can. Safe to repeat with an overlapping statement. */
  async importStatement(ctx: TenantContext, key: string, lines: StatementLineInput[]): Promise<ImportResult> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    if (!Array.isArray(lines) || !lines.length) throw validationFailed('The statement has no lines.');
    if (lines.length > MAX_IMPORT_LINES) throw validationFailed(`Import at most ${MAX_IMPORT_LINES} lines at a time.`);

    // The same text, amount and date may legitimately appear twice in one statement, so repeats are numbered.
    const seen = new Map<string, number>();
    const parsed: NewStatementLine[] = lines.map((l, i) => {
      const where = `Line ${i + 1}`;
      const date = checkDate(l.date, `${where}: date`);
      const paise = toPaise(l.amount, `${where}: amount`);
      if (paise === 0) throw validationFailed(`${where}: amount cannot be zero.`);
      const description = squash(String(l.description ?? ''));
      if (!description) throw validationFailed(`${where}: description is empty.`);
      if (description.length > 500) throw validationFailed(`${where}: description is longer than 500 characters.`);
      const reference = l.reference === undefined || l.reference === null ? null : squash(String(l.reference)).slice(0, 100) || null;
      const base = `${date}|${paise}|${(reference ?? '').toLowerCase()}|${description.toLowerCase()}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { date, amount: paiseToDecimal(paise), description, reference, fingerprint: sha256(`${base}|${n}`) };
    });

    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const account = await this.account(tx, key);
      const signed = await this.store.lastSignOff(tx, account.id);
      if (signed) {
        const late = parsed.filter((l) => l.date <= signed.asOf);
        const known = await this.store.existingFingerprints(tx, account.id, late.map((l) => l.fingerprint));
        const fresh = late.filter((l) => !known.has(l.fingerprint)).length;
        if (fresh) {
          throw ruleViolation(`${account.name} is signed off up to ${signed.asOf}. ${fresh} line${fresh === 1 ? ' is' : 's are'} new and dated on or before that day.`);
        }
      }
      const added = await this.store.addLines(tx, ctx.actor.id, account.id, parsed);
      const matched = added ? await this.autoMatch(tx, ctx, account) : 0;
      return { added, duplicates: parsed.length - added, matched };
    });
  }

  /** Pairs unmatched statement lines with ledger lines of the same amount dated within a few days; returns how many. */
  async autoMatchAccount(ctx: TenantContext, key: string): Promise<{ matched: number }> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => ({ matched: await this.autoMatch(tx, ctx, await this.account(tx, key)) }));
  }

  async statement(ctx: TenantContext, key: string, status?: string): Promise<StatementLine[]> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    if (status !== undefined && status !== 'unmatched' && status !== 'matched' && status !== 'ignored') {
      throw validationFailed('status must be unmatched, matched or ignored.');
    }
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const account = await this.account(tx, key);
      return this.store.lines(tx, account.id, { ...(status && { status }), limit: LIST_LIMIT });
    });
  }

  /** Entries on the account's ledger that no statement line has taken yet, oldest first: what a statement line can be paired with. */
  async bookLines(ctx: TenantContext, key: string, range: { from?: string; to?: string } = {}): Promise<BookLine[]> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    const from = range.from ? checkDate(range.from, 'From date') : undefined;
    const to = range.to ? checkDate(range.to, 'To date') : undefined;
    if (from && to && from > to) throw validationFailed('The from date is after the to date.');
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const account = await this.account(tx, key);
      return (await this.store.openBookLines(tx, account.ledgerAccountId, { ...(from && { from }), ...(to && { to }) })).slice(0, LIST_LIMIT);
    });
  }

  /** Pairs one statement line with a ledger line of the same amount, when the automatic pairing chose differently or found nothing. */
  async match(ctx: TenantContext, key: string, lineId: string, journalLineId: string): Promise<StatementLine> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const { account, line } = await this.open(tx, key, lineId);
      const book = await this.store.bookLine(tx, account.ledgerAccountId, journalLineId);
      if (!book) throw notFound('That entry is not on this account.');
      if (book.taken) throw ruleViolation('That entry is already paired with another statement line.');
      if (toPaise(book.amount) !== toPaise(line.amount)) {
        throw ruleViolation(`The statement line is ${line.amount} but the entry is ${book.amount}. Only lines of equal amount can be paired.`);
      }
      await this.store.setLine(tx, ctx.actor.id, line.id, { status: 'matched', journalLineId, note: null });
      return this.line(tx, account, line.id);
    });
  }

  /** Sets a line aside with a reason, for example a line the file repeated. It no longer counts on either side. */
  async ignore(ctx: TenantContext, key: string, lineId: string, note: string): Promise<StatementLine> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    const reason = squash(String(note ?? ''));
    if (!reason) throw validationFailed('Say why this line is being ignored.');
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const { account, line } = await this.open(tx, key, lineId);
      await this.store.setLine(tx, ctx.actor.id, line.id, { status: 'ignored', journalLineId: null, note: reason.slice(0, 500) });
      return this.line(tx, account, line.id);
    });
  }

  /** Puts a matched or ignored line back to unmatched. */
  async reopen(ctx: TenantContext, key: string, lineId: string): Promise<StatementLine> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const { account, line } = await this.open(tx, key, lineId, 'reopen');
      await this.store.setLine(tx, ctx.actor.id, line.id, { status: 'unmatched', journalLineId: null, note: null });
      return this.line(tx, account, line.id);
    });
  }

  /**
   * Records what the bank did and the books missed, such as a charge or interest: posts one entry dated on the
   * statement line, against `accountCode`, and pairs it with the line.
   */
  async book(ctx: TenantContext, key: string, lineId: string, input: BookLineInput): Promise<StatementLine> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    const code = String(input.accountCode ?? '').trim();
    if (!code) throw validationFailed('Choose the ledger account for the other side.');
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const { account, line } = await this.open(tx, key, lineId);
      if (code === account.ledgerCode) throw ruleViolation('The other side cannot be the bank account itself.');
      const other = await this.accounts.ledgerAccount(tx, code);
      if (!other) throw ruleViolation(`There is no ledger account '${code}'.`);
      if (other.linked) {
        throw ruleViolation(`'${code}' is another money account. Record the move as a transfer between the two accounts; it will pair with both statements.`);
      }
      const paise = toPaise(line.amount);
      const abs = paiseToDecimal(Math.abs(paise));
      const entryId = await this.ledger.post(tx, ctx.actor, {
        date: line.date,
        // The bank has already paid it, so the books must show it even when the account is at or below zero.
        overdraftReason: 'Booked from the bank statement',
        memo: `Bank: ${line.description}${input.memo?.trim() ? ` (${input.memo.trim()})` : ''}`.slice(0, 500),
        lines:
          paise > 0
            ? [
                { accountCode: account.ledgerCode, debit: abs },
                { accountCode: code, credit: abs },
              ]
            : [
                { accountCode: code, debit: abs },
                { accountCode: account.ledgerCode, credit: abs },
              ],
      });
      const journalLineId = await this.store.entryLineOn(tx, entryId, account.ledgerAccountId);
      if (!journalLineId) throw ruleViolation('The entry did not touch the bank account.');
      await this.store.setLine(tx, ctx.actor.id, line.id, { status: 'matched', journalLineId, note: null });
      return this.line(tx, account, line.id);
    });
  }

  /** Where the books stand against the statement on `asOf`: what is explained, what is outstanding, and what is left over. */
  async report(ctx: TenantContext, key: string, asOf: string, statementBalance: number | string): Promise<ReconciliationReport> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => this.build(tx, await this.account(tx, key), asOf, statementBalance));
  }

  /**
   * Records that the statement and the books agree on `asOf`. Needs every statement line up to that day booked,
   * paired or ignored, and nothing left unexplained. Entries the bank has not shown yet may stay outstanding.
   */
  async signOff(ctx: TenantContext, key: string, input: SignOffInput): Promise<SignOff> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const account = await this.account(tx, key);
      if (account.status !== 'active') throw ruleViolation('A closed account cannot be reconciled.');
      const report = await this.build(tx, account, input.asOf, input.statementBalance);
      if (report.lastSignOff && report.lastSignOff.asOf >= report.asOf) {
        throw ruleViolation(`${account.name} is already signed off up to ${report.lastSignOff.asOf}. Choose a later date.`);
      }
      const unbooked = report.unbooked.lines.length;
      if (unbooked) throw ruleViolation(`${unbooked} statement line${unbooked === 1 ? ' is' : 's are'} not in the books yet. Pair, book or ignore ${unbooked === 1 ? 'it' : 'them'} first.`);
      if (toPaise(report.difference) !== 0) throw ruleViolation(`The books and the statement differ by ${report.difference}. Find the difference before signing off.`);
      return this.store.addSignOff(tx, ctx.actor.id, account.id, {
        asOf: report.asOf,
        statementBalance: report.statementBalance,
        bookBalance: report.bookBalance,
        outstandingBook: report.outstandingBook.total,
        note: input.note?.trim() ? input.note.trim().slice(0, 500) : null,
      });
    });
  }

  async signOffs(ctx: TenantContext, key: string): Promise<SignOff[]> {
    demand(ctx.actor, RECONCILE_PERMISSION);
    return this.transactions.withTenant(ctx.tenantId, async (tx) => this.store.signOffs(tx, (await this.account(tx, key)).id));
  }

  private async build(tx: Tx, account: ReconAccount, asOfInput: string, statementBalance: number | string): Promise<ReconciliationReport> {
    const asOf = checkDate(asOfInput, 'As-of date');
    if (statementBalance === '') throw validationFailed('Statement balance is needed.');
    const statementPaise = toPaise(statementBalance, 'Statement balance');
    const bookBalance = await this.store.bookBalance(tx, account.ledgerAccountId, asOf);
    const outstanding = await this.store.openBookLines(tx, account.ledgerAccountId, { to: asOf });
    const unbooked = (await this.store.lines(tx, account.id, { status: 'unmatched', limit: LIST_LIMIT })).filter((l) => l.date <= asOf);
    const outstandingPaise = sumPaise(outstanding);
    const unbookedPaise = sumPaise(unbooked);
    // Statement less its unbooked lines equals books less their outstanding lines, when the two agree.
    const difference = statementPaise - toPaise(bookBalance) + outstandingPaise - unbookedPaise;
    return {
      asOf,
      statementBalance: paiseToDecimal(statementPaise),
      bookBalance,
      outstandingBook: { lines: outstanding, total: paiseToDecimal(outstandingPaise) },
      unbooked: { lines: unbooked, total: paiseToDecimal(unbookedPaise) },
      difference: paiseToDecimal(difference),
      reconciled: difference === 0 && unbooked.length === 0,
      lastSignOff: (await this.store.lastSignOff(tx, account.id)) ?? null,
    };
  }

  private async autoMatch(tx: Tx, ctx: TenantContext, account: ReconAccount): Promise<number> {
    const unmatched = await this.store.lines(tx, account.id, { status: 'unmatched', limit: LIST_LIMIT });
    if (!unmatched.length) return 0;
    const first = unmatched[0]!.date;
    const last = unmatched[unmatched.length - 1]!.date;
    const book = await this.store.openBookLines(tx, account.ledgerAccountId, { from: addDays(first, -MATCH_WINDOW_DAYS), to: addDays(last, MATCH_WINDOW_DAYS) });
    const taken = new Set<string>();
    let matched = 0;
    // Oldest statement line first; each takes the nearest-dated ledger line of the same amount. Lines of equal
    // amount are interchangeable for the balance, so which of two equals pairs first does not change any total.
    for (const line of unmatched) {
      let best: BookLine | undefined;
      let bestGap = Infinity;
      for (const b of book) {
        if (taken.has(b.id) || b.amount !== line.amount) continue;
        const gap = daysBetween(b.date, line.date);
        if (gap <= MATCH_WINDOW_DAYS && gap < bestGap) {
          best = b;
          bestGap = gap;
        }
      }
      if (!best) continue;
      taken.add(best.id);
      await this.store.setLine(tx, ctx.actor.id, line.id, { status: 'matched', journalLineId: best.id, note: null });
      matched += 1;
    }
    return matched;
  }

  private async account(tx: Tx, key: string): Promise<ReconAccount> {
    const account = await this.store.account(tx, key);
    if (!account) throw notFound(`Account '${key}' not found.`);
    return account;
  }

  /** The account and one of its statement lines, locked, and refused if the line sits in a signed-off period. */
  private async open(tx: Tx, key: string, lineId: string, intent: 'change' | 'reopen' = 'change'): Promise<{ account: ReconAccount; line: StatementLine }> {
    const account = await this.account(tx, key);
    const line = await this.store.lockLine(tx, account.id, lineId);
    if (!line) throw notFound('Statement line not found.');
    if (intent === 'change' && line.status !== 'unmatched') throw ruleViolation(`This line is already ${line.status}. Reopen it first to change it.`);
    if (intent === 'reopen' && line.status === 'unmatched') throw ruleViolation('This line is not paired or ignored.');
    const signed = await this.store.lastSignOff(tx, account.id);
    if (signed && line.date <= signed.asOf) throw ruleViolation(`${account.name} is signed off up to ${signed.asOf}; lines on or before that day cannot change.`);
    return { account, line };
  }

  private async line(tx: Tx, account: ReconAccount, lineId: string): Promise<StatementLine> {
    const line = await this.store.lockLine(tx, account.id, lineId);
    if (!line) throw notFound('Statement line not found.');
    return line;
  }
}
