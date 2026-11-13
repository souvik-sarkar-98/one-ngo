import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import type { WorkflowDef } from '../../definitions/types.js';
import { isPrimary } from '../../definitions/workflows.js';
import type { RecordRow } from '../query.js';
import type { Loaded, Move } from './context.js';
import { evalTest, scope } from './scope.js';

/** The primary workflow a record follows; records saved before several workflows existed follow the default. */
export function primaryOf(loaded: Loaded, row: Pick<RecordRow, 'workflow_key'>): WorkflowDef | undefined {
  return loaded.workflows.find((w) => w.key === row.workflow_key && isPrimary(w.body))?.body ?? loaded.workflow?.body;
}

export function parallelOf(loaded: Loaded): WorkflowDef[] {
  return loaded.workflows.filter((w) => !isPrimary(w.body)).map((w) => w.body);
}

export function moveOf(loaded: Loaded, row: Pick<RecordRow, 'workflow_key' | 'status' | 'workflow_state'>): Move {
  return { workflow: primaryOf(loaded, row)?.key ?? null, status: row.status, states: { ...(row.workflow_state ?? {}) } };
}

/** Starts parallel workflows: on create when they have no startsWhen, otherwise when it becomes true. */
export function startParallel(
  ctx: TenantContext,
  loaded: Loaded,
  data: Record<string, unknown>,
  move: Move,
  previous: Record<string, unknown> | null,
  creating: boolean,
): Record<string, string> {
  const states = { ...move.states };
  for (const w of parallelOf(loaded)) {
    if (w.key in states) continue;
    const start = w.startsWhen === undefined ? creating : evalTest(w.startsWhen, scope(ctx, data, move.status, previous, null, move), `workflow ${w.key}`);
    if (start) states[w.key] = w.initial;
  }
  return states;
}
