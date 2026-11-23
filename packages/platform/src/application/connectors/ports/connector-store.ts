import type { Tx } from '../../../domain/ports/transaction.js';

/** Organisation settings that name the email connector and the address it sends from. */
export const MAIL_CONNECTOR_SETTING = 'mail.connector';
export const MAIL_FROM_SETTING = 'mail.from';
/** The storage connector every new upload is written to. */
export const FILE_STORE_SETTING = 'files.storeConnector';

export type DeliveryStatus = 'pending' | 'sent' | 'failed';

export interface ConnectorRow {
  key: string;
  type: string;
  config: Record<string, unknown>;
  secret_enc: string | null;
  enabled: boolean;
  /** Set while the connector is archived: it is off, hidden from choices and kept with its delivery log. */
  archived_at: Date | string | null;
  updated_by: string | null;
  updated_at: Date | string;
}

export interface ConnectorListRow {
  key: string;
  type: string;
  config: Record<string, unknown>;
  secret_enc: string | null;
  enabled: boolean;
  archived_at: Date | string | null;
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
  /** The mail connector and From address saved in organisation settings. */
  mailChoice(tx: Tx): Promise<{ connector: string | null; from: string | null }>;
  /** Every email connector, so Settings can offer the enabled ones and still show a saved key that is off. */
  emailConnectors(tx: Tx): Promise<{ key: string; enabled: boolean; provider: string | null }[]>;
  /** The storage connector named in Settings, or null when none is saved. */
  storeChoice(tx: Tx): Promise<string | null>;
  /** Every storage connector, so Settings can offer the enabled ones and still show a saved key that is off. */
  storageConnectors(tx: Tx): Promise<{ key: string; enabled: boolean; provider: string | null; hasSecret: boolean }[]>;
  /** Whether files still name this storage connector, and whether Settings currently uses it. */
  storageHeld(tx: Tx, key: string): Promise<{ files: boolean; chosen: boolean }>;
  /** Connectors of the kinds, by key, each with its latest delivery. */
  list(tx: Tx, kinds: readonly string[]): Promise<ConnectorListRow[]>;
  /** Keys of the enabled connectors of the kind, in order. */
  enabledKeys(tx: Tx, kind: string): Promise<string[]>;
  save(tx: Tx, c: SaveConnector): Promise<void>;
  /** Archives the connector and switches it off, or lifts the archive (it stays off until someone switches it on). */
  setArchived(tx: Tx, key: string, archived: boolean, actorId: string): Promise<void>;
  /** Keys of the connectors that are not archived and sign in through the oauth connector `key`. */
  credentialUsers(tx: Tx, key: string): Promise<string[]>;
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