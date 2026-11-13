import type { Receipt } from '../../../domain/receipts/receipt-service.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { RecordRow } from '../query.js';
import type { SaveContext } from './context.js';
import { moveOf } from './moves.js';
import { resolveReceiptContent } from '../receipt-content.js';
import { evalTest, evalValue, scope } from './scope.js';

/**
 * Posting rules and receipt rules fire when a record enters their status:
 * the primary status by default, or a named workflow's state.
 */
export async function effects(tx: Tx, s: SaveContext, row: RecordRow): Promise<{ receipts: Receipt[]; journalEntryIds: string[] }> {
  const { ctx, loaded, previousStatus } = s;
  const previousStates = s.current?.workflow_state ?? {};
  const journalEntryIds: string[] = [];
  const receipts: Receipt[] = [];
  const move = moveOf(loaded, row);
  const entered = (r: { whenStatus: string; workflow?: string }) => {
    if (!r.workflow || r.workflow === move.workflow) return row.status !== previousStatus && row.status === r.whenStatus;
    const now = move.states[r.workflow];
    return now !== previousStates[r.workflow] && now === r.whenStatus;
  };
  if (![...loaded.postingRules, ...loaded.receiptRules].some(entered)) return { receipts, journalEntryIds };
  const ruleScope = scope(ctx, row.data, row.status, null, previousStatus, move);
  ruleScope.record = { ...row.data, id: row.id, number: row.number };

  for (const r of loaded.postingRules) {
    if (!entered(r)) continue;
    if (r.condition && !evalTest(r.condition, ruleScope, `posting rule ${r.key}`)) continue;
    const date = String(evalValue(r.date, ruleScope, `posting rule ${r.key} date`) ?? '');
    const lines = r.lines.map((l) => {
      const amount = evalValue(l.amount, ruleScope, `posting rule ${r.key} amount`);
      const accountCode = l.account ?? String(evalValue(l.accountExpr!, ruleScope, `posting rule ${r.key} account`));
      const fund = l.fund ? (evalValue(l.fund, ruleScope, `posting rule ${r.key} fund`) as string | null) : null;
      return l.side === 'debit' ? { accountCode, debit: amount as number, fund } : { accountCode, credit: amount as number, fund };
    });
    const memo = r.memo ? String(evalValue(r.memo, ruleScope, `posting rule ${r.key} memo`) ?? '') : undefined;
    journalEntryIds.push(await s.services.ledger.post(tx, ctx.actor, { date, memo, sourceRecordId: row.id, sourceRule: r.key, lines }));
  }

  for (const r of loaded.receiptRules) {
    if (!entered(r)) continue;
    if (r.condition && !evalTest(r.condition, ruleScope, `receipt rule ${r.key}`)) continue;
    const date = String(evalValue(r.date, ruleScope, `receipt rule ${r.key} date`) ?? '');
    const amount = evalValue(r.amount, ruleScope, `receipt rule ${r.key} amount`) as number;
    receipts.push(
      await s.services.receipts.issue(tx, ctx.actor, {
        seriesKey: r.series,
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
