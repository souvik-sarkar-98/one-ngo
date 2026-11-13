import type { Tx } from '../../../domain/ports/transaction.js';

/** A live record as automations read it, data as stored. */
export interface AutomationRecordRow {
  id: string;
  type_key: string;
  number: string | null;
  status: string | null;
  version: number;
  data: Record<string, unknown>;
  created_by: string | null;
}

/** Where a scheduled automation is: when it last ran, the run it owes, and how far through the records that run got. */
export interface AutomationState {
  last_run_at: Date | string | null;
  pending_due_at: Date | string | null;
  cursor_created_at: Date | string | null;
  cursor_id: string | null;
}

/** A change to the state; fields left out keep their stored value. */
export interface AutomationStateChange {
  lastRunAt?: Date;
  pendingDueAt?: Date | null;
  cursor?: { at: string; id: string } | null;
}

/** Automation runs, schedules and the records they read, for the organisation in the open transaction. */
export interface AutomationStore {
  state(tx: Tx, automationKey: string): Promise<AutomationState | undefined>;
  saveState(tx: Tx, automationKey: string, change: AutomationStateChange): Promise<void>;
  record(tx: Tx, id: string): Promise<AutomationRecordRow | undefined>;
  /** Up to `limit` records of the type (in the status, when given) after the cursor, oldest first. */
  recordsAfter(
    tx: Tx,
    typeKey: string,
    status: string | null | undefined,
    after: { at: string; id: string } | null,
    limit: number,
  ): Promise<(AutomationRecordRow & { created_at: Date })[]>;
  /** Claims one action of one automation run for the event; false when it was already claimed. */
  claimRun(tx: Tx, eventId: string, automationKey: string, actionIndex: number): Promise<boolean>;
}
