import type { JSONSchemaType } from 'ajv';
import { schemaOf } from './schema.js';

type ConnectorKind = 'sms' | 'whatsapp' | 'webhook' | 'http' | 'oauth';
const kind = { type: 'string', enum: ['sms', 'whatsapp', 'webhook', 'http', 'oauth'] } as const;

/** A connector's settings. Secrets are listed by name only; their values never leave the server. */
export interface ConnectorView {
  key: string;
  kind: ConnectorKind;
  enabled: boolean;
  configured: boolean;
  config: Record<string, unknown>;
  secrets: string[];
  oauth: { connected: boolean; expiresAt: string | null } | null;
  updatedBy: string | null;
  updatedAt: string;
}

export const connectorResponse: JSONSchemaType<ConnectorView> = {
  type: 'object',
  required: ['key', 'kind', 'enabled', 'configured', 'config', 'secrets', 'oauth', 'updatedBy', 'updatedAt'],
  additionalProperties: false,
  properties: {
    key: { type: 'string' },
    kind,
    enabled: { type: 'boolean' },
    configured: { type: 'boolean' },
    config: { type: 'object', required: [], additionalProperties: true },
    secrets: { type: 'array', items: { type: 'string' } },
    oauth: {
      anyOf: [
        {
          type: 'object',
          required: ['connected', 'expiresAt'],
          additionalProperties: false,
          properties: {
            connected: { type: 'boolean' },
            expiresAt: { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }] },
          },
        },
        { type: 'null', nullable: true },
      ],
    },
    updatedBy: { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }] },
    updatedAt: { type: 'string' },
  },
};

/** A test send or call: `to` is the SMS, WhatsApp or email recipient; `inputs` fills an http lookup's placeholders. */
export interface ConnectorTestRequest {
  to?: string;
  inputs?: Record<string, string>;
}

/** Nullable at the top so a request without a body still tests a webhook; Fastify validates a missing body as null. */
export const connectorTestRequest = {
  ...schemaOf<ConnectorTestRequest>({
    type: 'object',
    additionalProperties: false,
    properties: {
      to: { type: 'string', nullable: true },
      inputs: { type: 'object', nullable: true, required: [], additionalProperties: { type: 'string' } },
    },
  }),
  nullable: true,
};

/** The provider address to send the administrator's browser to. */
export interface ConnectorOauthStartResponse {
  url: string;
}

export const connectorOauthStartResponse: JSONSchemaType<ConnectorOauthStartResponse> = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: { url: { type: 'string' } },
};

export interface ConnectorSummary {
  key: string;
  kind: ConnectorKind;
  enabled: boolean;
  configured: boolean;
  usedBy: string[];
  lastDelivery: { status: 'pending' | 'sent' | 'failed'; at: string } | null;
}

export const connectorListResponse: JSONSchemaType<ConnectorSummary[]> = {
  type: 'array',
  items: {
    type: 'object',
    required: ['key', 'kind', 'enabled', 'configured', 'usedBy', 'lastDelivery'],
    additionalProperties: false,
    properties: {
      key: { type: 'string' },
      kind,
      enabled: { type: 'boolean' },
      configured: { type: 'boolean' },
      usedBy: { type: 'array', items: { type: 'string' } },
      lastDelivery: {
        anyOf: [
          {
            type: 'object',
            required: ['status', 'at'],
            additionalProperties: false,
            properties: { status: { type: 'string', enum: ['pending', 'sent', 'failed'] }, at: { type: 'string' } },
          },
          { type: 'null', nullable: true },
        ],
      },
    },
  },
};
