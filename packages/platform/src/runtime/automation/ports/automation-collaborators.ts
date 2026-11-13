import type { TransactionManager } from '../../../domain/ports/transaction.js';
import type { NotifyChannel, RecipientDef } from '../../definitions/types.js';

/** The record event an automation reacts to, as the outbox delivers it. */
export interface OutboxEvent {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** The organisations an automation tick walks, least recently ticked first. */
export interface TickTenants {
  activeIdsByTickOrder(): Promise<string[]>;
  markTicked(tenantId: string, at: Date): Promise<void>;
}

/** What an automation or record action asks to be sent. */
export interface NotifyInput {
  template: string;
  to: RecipientDef;
  channels?: NotifyChannel[];
  scope: Record<string, unknown>;
  recordId?: string;
  creatorId?: string | null;
  /** The record type of `scope.record`; its fields are masked for recipients who may not see them. */
  recordType?: string;
}

/** Sends notifications; `within` binds it to an open transaction so the notice commits with the change. */
export interface ActionNotifier {
  within(tm: TransactionManager): { notify(tenantId: string, input: NotifyInput): Promise<unknown> };
}
