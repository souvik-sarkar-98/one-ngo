import type { Receipt } from '../../../domain/receipts/receipt-service.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { PostingRuleDef } from '../../definitions/types.js';
import type { RecordRow } from '../query.js';
import type { SaveContext } from './context.js';
import { moveOf } from './moves.js';
import { resolveReceiptContent } from '../receipt-content.js';
import { evalTest, evalValue, scope } from './scope.js';

type RuleScope = ReturnType<typeof scope>;

function postingLines(r: PostingRuleDef, ruleScope: RuleScope) {
  return r.lines.map((l) => {
    const amount = evalValue(l.amount, ruleScope, `posting rule ${r.key} amount`);
    const accountCode = l.account ?? String(evalValue(l.accountExpr!, ruleScope, `posting rule ${r.key} account`));
    const fund = l.fund ? (evalValue(l.fund, ruleScope, `posting rule ${r.key} fund`) as string | null) : null;
    return l.side === 'debit' ? { accountCode, debit: amount as number, fund } : { accountCode, credit: amount as number, fund };
  });
}

/** The reason the rule's record gives for overdrawing an account; none when the rule has no such expression or it is empty. */
function overdraftReasonOf(r: PostingRuleDef, ruleScope: RuleScope): string | undefined {
  if (!r.overdraftReason) return undefined;
  const v = evalValue(r.overdraftReason, ruleScope, `posting rule ${r.key} overdraft reason`);
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Before a step is sent for approval: the posting rules the step would fire, checked against the money accounts
 * with what the person has filled in so far, so a payment that cannot be made is refused now and not after approval.
 * Nothing is posted.
 */
export async function checkPostingOverdraft(tx: Tx, s: SaveContext): Promise<void> {
  const { ctx, loaded, move } = s;
  const previous = s.current ? moveOf(loaded, s.current) : undefined;
  const ruleScope = scope(ctx, s.data, move.status, s.current?.data ?? null, s.previousStatus, move);
  ruleScope.record = { ...s.data, id: s.current?.id, number: s.current?.number };
  for (const r of loaded.postingRules) {
    const entering = r.workflow && r.workflow !== move.workflow ? move.states[r.workflow] !== previous?.states[r.workflow] && move.states[r.workflow] === r.whenStatus : move.status !== previous?.status && move.status === r.whenStatus;
    if (!entering) continue;
    if (r.condition && !evalTest(r.condition, ruleScope, `posting rule ${r.key}`)) continue;
    await s.services.ledger.checkOverdraft(tx, { lines: postingLines(r, ruleScope), overdraftReason: overdraftReasonOf(r, ruleScope) });
  }
}

/** A journal entry a save makes: the posting rule's date, memo, overdraft reason and lines, evaluated. */
export interface PlannedPosting {
  rule: string;
  date: string;
  memo?: string;
  overdraftReason?: string;
  lines: { accountCode: string; debit?: number; credit?: number; fund: string | null }[];
}

/** Whether a rule fires for the save: it enters its status (or its named workflow's state) in this save. */
function entering(s: SaveContext, row: RecordRow) {
  const previousStates = s.current?.workflow_state ?? {};
  const move = moveOf(s.loaded, row);
  const enters = (r: { whenStatus: string; workflow?: string }) => {
    if (!r.workflow || r.workflow === move.workflow) return row.status !== s.previousStatus && row.status === r.whenStatus;
    const now = move.states[r.workflow];
    return now !== previousStates[r.workflow] && now === r.whenStatus;
  };
  return { move, enters };
}

/** The posting rules that fire when `row` is saved in this save, evaluated. Nothing is written. */
function firingPostings(s: SaveContext, row: RecordRow): PlannedPosting[] {
  const { ctx, loaded } = s;
  const { move, enters } = entering(s, row);
  const ruleScope = scope(ctx, row.data, row.status, null, s.previousStatus, move);
  ruleScope.record = { ...row.data, id: row.id, number: row.number };
  const out: PlannedPosting[] = [];
  for (const r of loaded.postingRules) {
    if (!enters(r)) continue;
    if (r.condition && !evalTest(r.condition, ruleScope, `posting rule ${r.key}`)) continue;
    out.push({
      rule: r.key,
      date: String(evalValue(r.date, ruleScope, `posting rule ${r.key} date`) ?? ''),
      memo: r.memo ? String(evalValue(r.memo, ruleScope, `posting rule ${r.key} memo`) ?? '') : undefined,
      overdraftReason: overdraftReasonOf(r, ruleScope),
      lines: postingLines(r, ruleScope),
    });
  }
  return out;
}

/**
 * The journal entries a prepared save would make, for a migration check. The context's data is the
 * data as it would be saved and its move the status it would be saved in. Nothing is written.
 */
export function previewPostings(s: SaveContext): PlannedPosting[] {
  const row = { id: '', number: null, status: s.move.status, data: s.data, workflow_key: s.move.workflow, workflow_state: s.move.states } as unknown as RecordRow;
  return firingPostings(s, row);
}

/**
 * Posting rules and receipt rules fire when a record enters their status:
 * the primary status by default, or a named workflow's state.
 *
 * A migration's save (`s.history`) posts the entries of its posting rules, dated as the rules date them,
 * and issues no receipt: the legacy receipt numbers are data on the row, and the books carry the
 * opening balances.
 */
export async function effects(tx: Tx, s: SaveContext, row: RecordRow): Promise<{ receipts: Receipt[]; journalEntryIds: string[] }> {
  const { ctx, loaded, previousStatus } = s;
  const journalEntryIds: string[] = [];
  const receipts: Receipt[] = [];
  for (const p of firingPostings(s, row)) {
    journalEntryIds.push(await s.services.ledger.post(tx, ctx.actor, { date: p.date, memo: p.memo, overdraftReason: p.overdraftReason, sourceRecordId: row.id, sourceRule: p.rule, lines: p.lines }));
  }
  if (s.history) return { receipts, journalEntryIds };
  const { move, enters } = entering(s, row);
  if (!loaded.receiptRules.some(enters)) return { receipts, journalEntryIds };
  const ruleScope = scope(ctx, row.data, row.status, null, previousStatus, move);
  ruleScope.record = { ...row.data, id: row.id, number: row.number };

  for (const r of loaded.receiptRules) {
    if (!enters(r)) continue;
    if (r.condition && !evalTest(r.condition, ruleScope, `receipt rule ${r.key}`)) continue;
    const date = String(evalValue(r.date, ruleScope, `receipt rule ${r.key} date`) ?? '');
    const amount = evalValue(r.amount, ruleScope, `receipt rule ${r.key} amount`) as number;
    receipts.push(
      await s.services.receipts.issue(tx, ctx.actor, {
        seriesKey: r.series,
        ruleKey: r.key,
        date,
        amount,
        recordId: row.id,
        wording: (facts) =>
          resolveReceiptContent({
            ruleKey: r.key,
            layout: r.layout,
            record: { ...row.data, id: row.id, number: row.number, status: row.status },
            recordType: { label: s.type.label, titleField: s.type.titleField ?? null, fields: s.type.fields },
            receipt: { number: facts.number, amount: facts.amount, date: facts.date },
            seriesLabel: facts.series.label,
            issuer: facts.issuer,
          }),
      }),
    );
  }
  return { receipts, journalEntryIds };
}
