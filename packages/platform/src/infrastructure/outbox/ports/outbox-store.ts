import type { SqlExecutor } from '../../postgres/db.js';

/** What the outbox dispatcher needs from the place events are kept. The PostgreSQL implementation is in src/infrastructure/postgres/stores/outbox-store.ts. */

export interface OutboxEvent {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface ClaimedEvent extends OutboxEvent {
  doneHandlers: string[];
}

export interface OutboxStore {
  /** Takes up to `n` due events (pending, or processing with an expired lease), raising `attempts` and setting a lease. */
  claim(n: number): Promise<ClaimedEvent[]>;
  /** Marks the event done, only while the run still owns it (`attempts` unchanged). */
  markDone(eventId: string, attempts: number): Promise<void>;
  /** Records a failure and schedules the retry after `2 ** attempts` minutes; `final` ends it as failed. Only while the run still owns the event. */
  markFailed(eventId: string, attempts: number, final: boolean, message: string): Promise<void>;
  /** Extends the lease while the run still owns the event; false when it no longer does. */
  renew(eventId: string, attempts: number): Promise<boolean>;
  /** Records a handler as finished in a transaction the caller holds. */
  recordDone(tx: SqlExecutor, eventId: string, name: string): Promise<void>;
  /** Records a handler as finished in its own system transaction. */
  recordDoneNow(eventId: string, name: string): Promise<void>;
}
