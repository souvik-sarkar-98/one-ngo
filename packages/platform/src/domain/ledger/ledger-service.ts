import type { Actor } from '../ports/tenant-context.js';
import { notFound, ruleViolation, validationFailed } from '@onengo/kernel/errors';
import type { Tx } from '../ports/transaction.js';
import { fiscalYearBounds, fiscalYearKey, isFiscalYearKey } from './fiscal-year.js';
import type { LedgerStore, TrialBalanceRow } from './ports/ledger-store.js';
import { paiseToDecimal, toPaise } from '../money.js';

export type { TrialBalanceRow } from './ports/ledger-store.js';

export interface JournalLineInput {
  accountCode: string;
  debit?: number | string;
  credit?: number | string;
  fund?: string | null;
}

export interface JournalEntryInput {
  date: string;
  memo?: string;
  sourceRecordId?: string;
  sourceRule?: string;
  reversesEntryId?: string;
  lines: JournalLineInput[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Double-entry ledger. Every write path, including posting rules and scripts,
 * comes through here; the database triggers repeat the same checks.
 */
export class LedgerService {
  constructor(private readonly store: LedgerStore) {}

  /** Opens the financial year `key`, which fixes the organisation's start month from then on. */
  async openFiscalYear(tx: Tx, actor: Actor, key: string): Promise<void> {
    await this.store.holdFiscalYearStart(tx);
    const startMonth = await this.store.fiscalYearStartMonth(tx);
    if (!isFiscalYearKey(key, startMonth)) {
      throw validationFailed(`Financial year must look like ${fiscalYearKey(new Date().toISOString().slice(0, 10), startMonth)}.`);
    }
    const { startsOn, endsOn } = fiscalYearBounds(key, startMonth);
    await this.store.openPeriod(tx, actor.id, { key, startsOn, endsOn });
  }

  async closePeriod(tx: Tx, actor: Actor, key: string): Promise<void> {
    if (!(await this.store.closePeriod(tx, actor.id, key))) throw notFound(`No open period '${key}'.`);
  }

  async reopenPeriod(tx: Tx, actor: Actor, key: string, reason: string): Promise<void> {
    if (!reason?.trim()) throw validationFailed('A reason is required to reopen a period.');
    if (!(await this.store.reopenPeriod(tx, actor.id, key, reason.trim()))) throw notFound(`No closed period '${key}'.`);
  }

  async post(tx: Tx, actor: Actor, input: JournalEntryInput): Promise<string> {
    if (!ISO_DATE.test(input.date)) throw validationFailed('Entry date must be an ISO date.');
    if (input.lines.length < 2) throw ruleViolation('A journal entry needs at least two lines.');

    let debit = 0;
    let credit = 0;
    const lines = input.lines.map((l, i) => {
      const d = l.debit === undefined || l.debit === null ? 0 : toPaise(l.debit, `line ${i + 1} debit`);
      const c = l.credit === undefined || l.credit === null ? 0 : toPaise(l.credit, `line ${i + 1} credit`);
      if (d < 0 || c < 0) throw ruleViolation('Journal amounts cannot be negative.');
      if ((d === 0) === (c === 0)) throw ruleViolation('Each journal line is either a debit or a credit.');
      debit += d;
      credit += c;
      return { ...l, d, c };
    });
    if (debit !== credit) {
      throw ruleViolation(`Journal entry does not balance: debits ${paiseToDecimal(debit)}, credits ${paiseToDecimal(credit)}.`);
    }

    const codes = [...new Set(lines.map((l) => l.accountCode))];
    const accounts = await this.store.accounts(tx, codes);
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    for (const code of codes) {
      const a = byCode.get(code);
      if (!a) throw ruleViolation(`Ledger account '${code}' does not exist.`);
      if (!a.active) throw ruleViolation(`Ledger account '${code}' is inactive.`);
    }

    const fy = fiscalYearKey(input.date, await this.store.fiscalYearStartMonth(tx));
    const period = await this.store.period(tx, fy);
    if (!period) throw ruleViolation(`Financial year ${fy} is not open.`);
    if (period.status !== 'open') throw ruleViolation(`Financial year ${fy} is closed.`);

    return this.store.insertEntry(tx, actor.id, {
      periodId: period.id,
      date: input.date,
      memo: input.memo ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      sourceRule: input.sourceRule ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      lines: lines.map((l) => ({ accountId: byCode.get(l.accountCode)!.id, debit: paiseToDecimal(l.d), credit: paiseToDecimal(l.c), fund: l.fund ?? null })),
      total: paiseToDecimal(debit),
    });
  }

  /** Reverses a posted entry with an equal and opposite entry on `date`. */
  async reverse(tx: Tx, actor: Actor, entryId: string, date: string, reason: string): Promise<string> {
    if (!reason?.trim()) throw validationFailed('A reason is required to reverse an entry.');
    const status = await this.store.entryStatus(tx, entryId);
    if (!status) throw notFound('Journal entry not found.');
    if (status !== 'posted') throw ruleViolation('This entry has already been reversed.');
    const lines = await this.store.entryLines(tx, entryId);
    const reversalId = await this.post(tx, actor, {
      date,
      memo: `Reversal: ${reason.trim()}`,
      reversesEntryId: entryId,
      lines: lines.map((l) => ({
        accountCode: l.code,
        debit: Number(l.credit) > 0 ? l.credit : undefined,
        credit: Number(l.debit) > 0 ? l.debit : undefined,
        fund: l.fund,
      })),
    });
    await this.store.markReversed(tx, entryId);
    return reversalId;
  }

  async trialBalance(tx: Tx, fiscalYear: string): Promise<TrialBalanceRow[]> {
    return this.store.trialBalance(tx, fiscalYear);
  }
}
