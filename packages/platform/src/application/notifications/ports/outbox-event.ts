/** An event claimed from the transactional outbox, as the notification use case receives it. */
export interface OutboxEvent {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}
