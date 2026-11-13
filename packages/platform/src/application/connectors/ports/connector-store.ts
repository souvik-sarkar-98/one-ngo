import type { Tx } from '../../../domain/ports/transaction.js';

export type DeliveryStatus = 'pending' | 'sent' | 'failed';

export interface ConnectorRow {
  key: string;
  type: string;
  config: Record<string, unknown>;
  secret_enc: string | null;
  enabled: boolean;
  updated_by: string | null;
  updated_at: Date | string;
}

export interface ConnectorListRow {
  key: string;
  type: string;
  secret_enc: string | null;
  enabled: boolean;
  last_status: DeliveryStatus | null;
  last_at: Date | string | null;
}

export interface DeliveryRow {
  id: string;
  event: string;
  record_id: string | null;
  status: DeliveryStatus;
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: Date | string;
  last_attempt_at: Date | string | null;
}

export interface SaveConnector {
  key: string;
  type: string;
  config: unknown;
  secretEnc: string | null;
  enabled: boolean;
  actorId: string;
}

/** One call to a connector; a retried queued event (same `eventId`) updates its log row. */
export interface DeliveryAttempt {
  connectorKey: string;
  event: string;
  recordId: string | null;
  status: DeliveryStatus;
  responseStatus: number | null;
  error: string | null;
  eventId: string | null;
}

/** Connectors and their delivery log in the organisation of the open transaction. */
export interface ConnectorStore {
  connector(tx: Tx, key: string): Promise<ConnectorRow | undefined>;
  /** The connector, locked for update until the transaction ends. */
  lockConnector(tx: Tx, key: string): Promise<ConnectorRow | undefined>;
  /** Replaces only the encrypted secrets. */
  updateSecrets(tx: Tx, key: string, secretEnc: string | null): Promise<void>;
  /** The enabled http connector that sends the organisation's email, if any. */
  emailSender(tx: Tx): Promise<ConnectorRow | undefined>;
  /** Connectors of the kinds, by key, each with its latest delivery. */
  list(tx: Tx, kinds: readonly string[]): Promise<ConnectorListRow[]>;
  /** Keys of the enabled connectors of the kind, in order. */
  enabledKeys(tx: Tx, kind: string): Promise<string[]>;
  save(tx: Tx, c: SaveConnector): Promise<void>;
  delivery(tx: Tx, connectorKey: string, deliveryId: string): Promise<{ status: DeliveryStatus; outbox_event_id: string | null } | undefined>;
  markDeliveryPending(tx: Tx, deliveryId: string): Promise<void>;
  deliveries(tx: Tx, connectorKey: string, limit: number, offset: number): Promise<DeliveryRow[]>;
  /** Whether the queued event was already delivered. */
  sentFor(tx: Tx, eventId: string): Promise<boolean>;
  /** Logs a queued event that was not sent, once. */
  recordNotSent(tx: Tx, attempt: Omit<DeliveryAttempt, 'status' | 'responseStatus' | 'eventId'> & { eventId: string }): Promise<void>;
  recordAttempt(tx: Tx, attempt: DeliveryAttempt): Promise<void>;
  organisation(tx: Tx): Promise<{ id: string; key: string; name: string } | undefined>;
}
