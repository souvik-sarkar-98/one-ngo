import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import { executorOf } from '../postgres/tx.js';
import { enqueueEvent, writeAudit } from '../postgres/stores/audit-store.js';

/** Writes audit and outbox events on the open transaction's executor; the composition root binds it to the domain's audit port. */
export const pgAuditTrail: AuditTrail = {
  audit: (tx, input) => writeAudit(executorOf(tx), input),
  event: (tx, type, payload) => enqueueEvent(executorOf(tx), type, payload),
};
