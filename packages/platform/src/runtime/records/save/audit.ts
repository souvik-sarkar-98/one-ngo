import type { Tx } from '../../../domain/ports/transaction.js';
import { auditSnapshots } from '../audit-snapshot.js';
import type { RecordRow } from '../query.js';
import type { SaveContext } from './context.js';

/** The audit entry and the outbox event of a save, `record.created` on create. */
export async function auditAndOutbox(tx: Tx, s: SaveContext, row: RecordRow, event: string): Promise<void> {
  const { ctx, type, current } = s;
  const { store } = s.services;
  await store.audit(tx, {
    actorId: ctx.actor.id,
    action: event,
    entity: `record:${row.type_key}`,
    entityId: row.id,
    ...auditSnapshots(type, current ? { data: current.data, status: current.status } : null, { data: s.data, status: s.status }),
  });
  await store.enqueueEvent(tx, event, {
    id: row.id,
    type: row.type_key,
    status: s.status,
    previousStatus: s.previousStatus,
    workflow: s.move.workflow,
    states: s.move.states,
    previousStates: current?.workflow_state ?? {},
    transition: s.transition?.key ?? null,
    actorId: ctx.actor.id,
    depth: ctx.depth ?? 0,
    causedBy: ctx.causedBy ?? null,
    ...(ctx.quiet ? { quiet: true } : {}),
  });
}