import type { Tx } from './transaction.js';

export interface AuditInput {
  actorId: string;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** What writes audit events and outbox events in an open transaction. Services receive it through their constructor; src/composition/ supplies the adapter. */
export interface AuditTrail {
  audit(tx: Tx, input: AuditInput): Promise<void>;
  event(tx: Tx, type: string, payload: unknown): Promise<void>;
}
