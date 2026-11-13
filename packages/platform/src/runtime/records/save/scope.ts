import { compileExpression, ExpressionError } from '../../expressions/expression.js';
import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import { ruleViolation } from '@onengo/kernel/errors';
import type { Move } from './context.js';

/** Empty values (missing, null, blank text) count as the same; other values compare by JSON. */
export function sameFieldValue(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  return JSON.stringify(typeof a === 'string' ? a.trim() : a) === JSON.stringify(typeof b === 'string' ? b.trim() : b);
}

export function scope(
  ctx: TenantContext,
  data: Record<string, unknown>,
  status: string | null,
  previous: Record<string, unknown> | null,
  previousStatus: string | null = null,
  move?: Move,
): Record<string, unknown> {
  return {
    record: data,
    previous: previous ?? {},
    status,
    previousStatus,
    workflow: move?.workflow ?? null,
    states: { ...(move?.states ?? {}), ...(move?.workflow ? { [move.workflow]: status } : {}) },
    user: { id: ctx.actor.id, roles: [...ctx.actor.roles] },
  };
}

export function evalValue(source: string, scope: Record<string, unknown>, where: string): unknown {
  try {
    return compileExpression(source).evaluate(scope);
  } catch (e) {
    if (e instanceof ExpressionError) throw ruleViolation(`Configuration error in ${where}: ${e.message}`);
    throw e;
  }
}

export function evalTest(source: string, scope: Record<string, unknown>, where: string): boolean {
  try {
    return compileExpression(source).test(scope);
  } catch (e) {
    if (e instanceof ExpressionError) throw ruleViolation(`Configuration error in ${where}: ${e.message}`);
    throw e;
  }
}
