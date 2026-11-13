import { ruleViolation, validationFailed } from '@onengo/kernel/errors';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { SaveContext } from './context.js';
import { evalTest, scope } from './scope.js';

/** The record type's rules, each checked when its `when` holds. */
export async function rules(_tx: Tx, s: SaveContext): Promise<void> {
  const ruleScope = scope(s.ctx, s.data, s.status, s.previous, s.previousStatus, s.move);
  for (const rule of s.type.rules ?? []) {
    if (rule.when && !evalTest(rule.when, ruleScope, `rule ${rule.key}`)) continue;
    if (!evalTest(rule.expression, ruleScope, `rule ${rule.key}`)) {
      const path = rule.field ? `/${rule.field}` : '/';
      throw validationFailed(rule.message, [{ path, message: rule.message }]);
    }
  }
}

/** The step's guard, judged against the prepared data. */
export function guard(s: SaveContext): void {
  const t = s.transition;
  if (!t?.guard) return;
  if (!evalTest(t.guard, scope(s.ctx, s.data, s.status, s.previous, s.previousStatus, s.move), 'guard')) {
    throw ruleViolation(t.guardMessage ?? `'${t.label}' is not allowed for this record.`);
  }
}
