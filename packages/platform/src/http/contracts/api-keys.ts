import type { JSONSchemaType } from 'ajv';
import { schemaOf } from './schema.js';

export interface CreateApiKeyRequest {
  name: string;
  /** Key of the role whose permissions the key acts with. Set this or `feed`, not both. */
  role?: string;
  /** Key of the published data feed this key may read. Set this or `role`, not both. */
  feed?: string;
}

export const createApiKeyRequest = schemaOf<CreateApiKeyRequest>({
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    role: { type: 'string', nullable: true },
    feed: { type: 'string', nullable: true },
  },
});

export interface ApiKeyView {
  id: string;
  name: string;
  role: string | null;
  feed: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Only the create answer carries `token` (`<id>.<secret>`); it is never shown again. */
export interface CreatedApiKey extends ApiKeyView {
  token: string;
}

export interface ApiKeyFeedChoice {
  key: string;
  label: string;
}

const textOrNull = { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }] } as const;
const keyProperties = {
  id: { type: 'string' },
  name: { type: 'string' },
  role: textOrNull,
  feed: textOrNull,
  createdBy: { type: 'string' },
  createdAt: { type: 'string' },
  lastUsedAt: textOrNull,
  revokedAt: textOrNull,
} as const;
const keyRequired = ['id', 'name', 'role', 'feed', 'createdBy', 'createdAt', 'lastUsedAt', 'revokedAt'] as const;

export const apiKeyListResponse: JSONSchemaType<ApiKeyView[]> = {
  type: 'array',
  items: { type: 'object', required: [...keyRequired], additionalProperties: false, properties: keyProperties },
};

export const createdApiKeyResponse: JSONSchemaType<CreatedApiKey> = {
  type: 'object',
  required: [...keyRequired, 'token'],
  additionalProperties: false,
  properties: { ...keyProperties, token: { type: 'string' } },
};

export const apiKeyFeedListResponse: JSONSchemaType<ApiKeyFeedChoice[]> = {
  type: 'array',
  items: {
    type: 'object',
    required: ['key', 'label'],
    additionalProperties: false,
    properties: { key: { type: 'string' }, label: { type: 'string' } },
  },
};
