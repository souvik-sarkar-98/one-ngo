import type { Actor } from '../../domain/ports/tenant-context.js';
import { can } from '../../domain/permissions.js';
import type { RecordTypeDef, WorkflowDef } from '../definitions/types.js';
import { approvableSteps } from '../definitions/workflows.js';
import type { RecordPredicate } from './query-ast.js';

/** Records shared with the person that are not their own: the "Shared with me" chip. */
export function sharedWithMePredicate(actor: Actor): RecordPredicate {
  return { kind: 'sharedWith', person: actor.id, roles: actor.roles };
}

/**
 * The one condition for which records of a restricted type a person may see
 * in lists, totals, exports and related sections: their own, those shared
 * with them or one of their roles (unexpired), those whose pending step they
 * may approve, or all with record:<type>:read:all. Null when nothing is hidden.
 */
export function visibilityPredicate(type: RecordTypeDef, workflows: WorkflowDef[], actor: Actor): RecordPredicate | null {
  if (type.visibility !== 'restricted' || can(actor, `record:${type.key}:read:all`)) return null;
  return { kind: 'visibleTo', person: actor.id, roles: actor.roles, approvableSteps: approvableSteps(actor, workflows).map((s) => s.step.key) };
}
