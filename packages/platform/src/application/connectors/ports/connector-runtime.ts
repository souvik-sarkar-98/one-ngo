export interface ConnectorRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
  /** Default 10 seconds. */
  timeoutMs?: number;
  /** Characters of the response body kept; default 2000. */
  maxBodyBytes?: number;
}

export interface ConnectorResponse {
  status: number;
  body: string;
}

/** Outbound HTTP for connectors; replaced in tests so nothing leaves the process. */
export type ConnectorHttp = (request: ConnectorRequest) => Promise<ConnectorResponse>;

/** Stored connector credentials, encrypted under the installation's key, and the signature on webhooks. */
export interface ConnectorSecretBox {
  encrypt(plaintext: string): string;
  decrypt(stored: string): string;
  /** Hex HMAC-SHA256 of `data` under `secret`. */
  sign(secret: string, data: string): string;
}

/** Sends one organisation's outbox event again, to every handler, with at least one attempt left. */
export interface ConnectorOutbox {
  requeue(tenantId: string, eventId: string): Promise<void>;
}

/** A pending "connect" of an oauth connector, from the authorization redirect to its callback. */
export interface ConnectorOauthStart {
  stateHash: string;
  tenantId: string;
  connectorKey: string;
  codeVerifier: string;
  actorId: string;
}

/** The owner-level store of pending oauth connects; each lasts ten minutes and is used once. */
export interface ConnectorOauthStates {
  startConnectorOauth(start: ConnectorOauthStart): Promise<void>;
  /** Marks the unexpired, unused attempt used and returns it. */
  useConnectorOauth(stateHash: string): Promise<{ tenant_id: string; connector_key: string; code_verifier: string; actor_id: string } | undefined>;
}

/** The outbox event a webhook delivery handles. */
export interface ConnectorEvent {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** How often the outbox tries an event before it is final. */
export interface ConnectorDeliveryPolicy {
  maxAttempts: number;
}
