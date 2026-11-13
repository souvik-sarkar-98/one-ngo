import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import { joinTx } from '../../domain/transaction-scope.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { EnqueueEvent, RecordsInTx } from '../actions/ports/action-ports.js';

/** Record operations that join a transaction another service already holds, so they commit or roll back together. */
export function recordsInTx(records: RecordService): RecordsInTx {
  return (tenantId, tx, defs) => records.within(joinTx(tenantId, tx), defs);
}

/** Queues outbox events through the audit trail, in the transaction the caller holds. */
export function enqueueThrough(trail: AuditTrail): EnqueueEvent {
  return (tx, type, payload) => trail.event(tx, type, payload);
}
