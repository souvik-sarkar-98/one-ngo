/** An audit event written in the open transaction. */
export interface AuditInput {
  actorId: string;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}
