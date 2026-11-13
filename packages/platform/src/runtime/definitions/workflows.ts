import type { Actor } from '../../domain/ports/tenant-context.js';
import type { ApprovalDef, WorkflowDef } from './types.js';

export const isPrimary = (w: Pick<WorkflowDef, 'role'>) => w.role !== 'parallel';

/** Whether a person is one of a step's approvers (by role or by name). */
export function isApprover(actor: Actor, approval: ApprovalDef): boolean {
  return (approval.roles ?? []).some((r) => actor.roles.includes(r)) || (approval.users ?? []).includes(actor.id);
}

/** Every step of these workflows the person may approve; the one source for deciding, the approvals query and visibility. */
export function approvableSteps(actor: Actor, workflows: WorkflowDef[]): { workflow: WorkflowDef; step: WorkflowDef['transitions'][number] }[] {
  return workflows.flatMap((workflow) =>
    workflow.transitions.filter((t) => t.approval && isApprover(actor, t.approval)).map((step) => ({ workflow, step })),
  );
}

/** The step with this key in any of the workflows. */
export function findStep(workflows: WorkflowDef[], key: string): { workflow: WorkflowDef; step: WorkflowDef['transitions'][number] } | undefined {
  for (const workflow of workflows) {
    const step = workflow.transitions.find((t) => t.key === key);
    if (step) return { workflow, step };
  }
  return undefined;
}

/** 0: the primary workflow without appliesWhen (the default), 1: other primary workflows, 2: parallel workflows. */
const rank = (w: WorkflowDef) => (!isPrimary(w) ? 2 : w.appliesWhen === undefined ? 0 : 1);

/**
 * A record type's workflows in the order they are considered: the default
 * primary workflow first, then the other primary ones, then parallel ones,
 * each in key order.
 */
export function workflowsOf<T>(items: T[], recordType: string, body: (item: T) => WorkflowDef): T[] {
  return items
    .filter((i) => body(i).recordType === recordType)
    .sort((a, b) => rank(body(a)) - rank(body(b)) || body(a).key.localeCompare(body(b).key));
}
