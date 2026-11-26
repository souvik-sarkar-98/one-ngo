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
  /**
   * Why the entry may take a money account that does not allow an overdraft below zero. Without it such an
   * entry is refused; with it the entry is posted and the override is written to the audit trail.
   */
  overdraftReason?: string;
  lines: JournalLineInput[];
}

/** What a posting needs checked against the money accounts: its lines and the reason given for overdrawing, if any. */
export type OverdraftCheck = Pick<JournalEntryInput, 'lines' | 'overdraftReason'>;

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

    const overdraft = await this.overdrawn(
      tx,
      lines.map((l) => ({ accountId: byCode.get(l.accountCode)!.id, net: l.d - l.c })),
      input.overdraftReason,
    );

    return this.store.insertEntry(tx, actor.id, {
      overdraft,
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

  /**
   * Refuses lines that would take a money account below zero when it does not allow that, unless a reason is
   * given. Posts nothing: used to warn when a step is sent for approval, before anything is posted.
   */
  async checkOverdraft(tx: Tx, input: OverdraftCheck): Promise<void> {
    const net = new Map<string, number>();
    const codes = [...new Set(input.lines.map((l) => l.accountCode))];
    const byCode = new Map((await this.store.accounts(tx, codes)).map((a) => [a.code, a.id]));
    for (const [i, l] of input.lines.entries()) {
      const id = byCode.get(l.accountCode);
      if (!id) continue; // Posting reports an account that does not exist.
      const d = l.debit === undefined || l.debit === null ? 0 : toPaise(l.debit, `line ${i + 1} debit`);
      const c = l.credit === undefined || l.credit === null ? 0 : toPaise(l.credit, `line ${i + 1} credit`);
      net.set(id, (net.get(id) ?? 0) + d - c);
    }
    await this.overdrawn(tx, [...net].map(([accountId, n]) => ({ accountId, net: n })), input.overdraftReason);
  }

  /**
   * The money accounts, not allowed below zero, that these lines take below zero; the entry's override when there
   * are some and a reason is given. The accounts are locked first, so the balance read is the balance spent.
   */
  private async overdrawn(tx: Tx, lines: { accountId: string; net: number }[], reasonInput: string | undefined) {
    const net = new Map<string, number>();
    for (const l of lines) net.set(l.accountId, (net.get(l.accountId) ?? 0) + l.net);
    const spending = [...net].filter(([, n]) => n < 0).map(([id]) => id);
    if (!spending.length) return undefined;
    const held = await this.store.lockMoneyBalances(tx, spending);
    const breaches = held
      .filter((m) => !m.allowNegative && toPaise(m.balance) + (net.get(m.accountId) ?? 0) < 0)
      .map((m) => ({ ...m, after: toPaise(m.balance) + (net.get(m.accountId) ?? 0) }));
    if (!breaches.length) return undefined;
    const reason = typeof reasonInput === 'string' ? reasonInput.trim() : '';
    if (!reason) {
      const first = breaches[0]!;
      throw validationFailed(`${first.name} has only ${first.balance} available.`, [
        {
          path: '/overdraftReason',
          message: `${first.name} has only ${first.balance}, and this takes it to ${paiseToDecimal(first.after)}. Give a reason to go below zero.`,
        },
      ]);
    }
    return {
      reason,
      accounts: breaches.map((m) => ({ code: m.code, before: m.balance, after: paiseToDecimal(m.after) })),
    };
  }

  /**
   * Checks entries in the order they would be posted, without writing anything: each balances, uses accounts that exist
   * and are active, falls in an open financial year, and keeps a money account at or above zero unless it gives a reason.
   * `pending` holds, in paise by account code, what entries already taken (or opening balances not yet applied) move
   * each account by; the entries that pass are added to it, so the caller passes a copy it keeps only on success.
   * Returns the first refusal, or null.
   */
  async checkPlanned(tx: Tx, entries: { date: string; lines: JournalLineInput[]; overdraftReason?: string }[], pending: Map<string, number>): Promise<string | null> {
    for (const e of entries) {
      if (!ISO_DATE.test(e.date)) return `The entry date '${e.date}' is not a date.`;
      if (e.lines.length < 2) return 'A journal entry needs at least two lines.';
      const net = new Map<string, number>();
      let debit = 0;
      let credit = 0;
      try {
        for (const [i, l] of e.lines.entries()) {
          if (l.accountCode === 'null' || l.accountCode === 'undefined' || !l.accountCode) return 'A line of the entry has no ledger account for this row. Check the field the posting rule takes it from.';
          const d = l.debit === undefined || l.debit === null ? 0 : toPaise(l.debit, `line ${i + 1} debit`);
          const c = l.credit === undefined || l.credit === null ? 0 : toPaise(l.credit, `line ${i + 1} credit`);
          if (d < 0 || c < 0) return 'Journal amounts cannot be negative.';
          if ((d === 0) === (c === 0)) return 'Each journal line is either a debit or a credit.';
          debit += d;
          credit += c;
          net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + d - c);
        }
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      if (debit !== credit) return `Journal entry does not balance: debits ${paiseToDecimal(debit)}, credits ${paiseToDecimal(credit)}.`;
      const codes = [...net.keys()];
      const byCode = new Map((await this.store.accounts(tx, codes)).map((a) => [a.code, a]));
      for (const code of codes) {
        const a = byCode.get(code);
        if (!a) return `Ledger account '${code}' does not exist.`;
        if (!a.active) return `Ledger account '${code}' is inactive.`;
      }
      const fy = fiscalYearKey(e.date, await this.store.fiscalYearStartMonth(tx));
      const period = await this.store.period(tx, fy);
      if (!period) return `Financial year ${fy} is not open.`;
      if (period.status !== 'open') return `Financial year ${fy} is closed.`;
      const spending = codes.filter((code) => (net.get(code) ?? 0) < 0).map((code) => byCode.get(code)!.id);
      const reason = typeof e.overdraftReason === 'string' ? e.overdraftReason.trim() : '';
      if (spending.length && !reason) {
        for (const m of await this.store.lockMoneyBalances(tx, spending)) {
          if (m.allowNegative) continue;
          const available = toPaise(m.balance) + (pending.get(m.code) ?? 0);
          const after = available + (net.get(m.code) ?? 0);
          if (after < 0) return `${m.name} has only ${paiseToDecimal(available)} available, and this takes it to ${paiseToDecimal(after)}. Give a reason to go below zero.`;
        }
      }
      for (const [code, n] of net) pending.set(code, (pending.get(code) ?? 0) + n);
    }
    return null;
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
      // A reversal undoes what was posted, so it is never held back; the reason it gives is on the audit trail if it overdraws.
      overdraftReason: `Reversal: ${reason.trim()}`,
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

  /** The financial year that holds `date`: its label and its first and last day. */
  async fiscalYearOf(tx: Tx, date: string): Promise<{ key: string; startsOn: string; endsOn: string }> {
    if (!ISO_DATE.test(date)) throw validationFailed('Date must be like 2026-04-30.');
    const startMonth = await this.store.fiscalYearStartMonth(tx);
    const key = fiscalYearKey(date, startMonth);
    return { key, ...fiscalYearBounds(key, startMonth) };
  }

  async trialBalance(tx: Tx, fiscalYear: string): Promise<TrialBalanceRow[]> {
    return this.store.trialBalance(tx, fiscalYear);
  }

  /**
   * The trial balance on a date: each ledger account's net balance in the Debit or Credit column, and the
   * two totals, which are equal when the books are in order. Money, debts and funds carry forward from earlier
   * years; income and expenses are those of the financial year that holds the date.
   */
  async trialBalanceAsOn(tx: Tx, asOf: string, options: { includeZero?: boolean } = {}): Promise<TrialBalance> {
    if (!ISO_DATE.test(asOf) || new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf) throw validationFailed('As-on date must be a date like 2026-04-30.');
    const year = await this.fiscalYearOf(tx, asOf);
    const raw = await this.store.balancesAsOn(tx, { asOf, yearStart: year.startsOn });
    const line = (r: (typeof raw)[number], net: number): TrialBalanceLine => ({
      code: r.code,
      name: r.name,
      type: r.type,
      active: r.active,
      moneyKey: r.moneyKey,
      debit: net > 0 ? paiseToDecimal(net) : '0.00',
      credit: net < 0 ? paiseToDecimal(-net) : '0.00',
    });
    const rows = raw.map((r) => ({ line: line(r, toPaise(r.debit) - toPaise(r.credit)), net: toPaise(r.debit) - toPaise(r.credit) })).filter((x) => options.includeZero || x.net !== 0).map((x) => x.line);
    // Income and expenses restart each year, so the result of earlier years has to appear somewhere or the two columns would
    // drift apart. It shows as one fund line: the surplus (or deficit) the organisation has built up before this year.
    const earlier = raw.reduce((sum, r) => sum + toPaise(r.priorDebit) - toPaise(r.priorCredit), 0);
    if (earlier !== 0) rows.push({ code: SURPLUS_BROUGHT_FORWARD, name: 'Surplus from earlier years', type: 'equity', active: true, moneyKey: null, debit: earlier > 0 ? paiseToDecimal(earlier) : '0.00', credit: earlier < 0 ? paiseToDecimal(-earlier) : '0.00' });    const totalDebit = rows.reduce((sum, r) => sum + toPaise(r.debit), 0);
    const totalCredit = rows.reduce((sum, r) => sum + toPaise(r.credit), 0);
    return {
      asOf,
      year,
      rows,
      totalDebit: paiseToDecimal(totalDebit),
      totalCredit: paiseToDecimal(totalCredit),
      balanced: totalDebit === totalCredit,
    };
  }
}

/** The code of the line that rolls the income and expenses of earlier financial years into the funds. */
export const SURPLUS_BROUGHT_FORWARD = 'SURPLUS_BF';

export interface TrialBalanceLine {
  code: string;
  name: string;
  type: string;
  /** False for a ledger account that has been closed but still holds a balance. */
  active: boolean;
  /** The money account this ledger account belongs to, if any, so a screen can link to its statement. */
  moneyKey: string | null;
  debit: string;
  credit: string;
}

export interface TrialBalance {
  asOf: string;
  /** The financial year whose income and expenses are shown. */
  year: { key: string; startsOn: string; endsOn: string };
  rows: TrialBalanceLine[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}
