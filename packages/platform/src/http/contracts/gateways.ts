import type { JSONSchemaType } from 'ajv';
import { schemaOf } from './schema.js';

const filled = { type: 'string', minLength: 1 } as const;
const environment = { type: 'string', enum: ['sandbox', 'production'] } as const;

export interface RazorpayCredentialsRequest {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export const razorpayCredentialsRequest = schemaOf<RazorpayCredentialsRequest>({
  type: 'object',
  required: ['keyId', 'keySecret', 'webhookSecret'],
  additionalProperties: false,
  properties: { keyId: filled, keySecret: filled, webhookSecret: filled },
});

export interface CashfreeCredentialsRequest {
  /** The client id. */
  keyId: string;
  /** The client secret; it also signs Cashfree's webhooks. */
  keySecret: string;
  webhookSecret?: string;
  /** Default `sandbox`. */
  environment?: 'sandbox' | 'production';
}

export const cashfreeCredentialsRequest = schemaOf<CashfreeCredentialsRequest>({
  type: 'object',
  required: ['keyId', 'keySecret'],
  additionalProperties: false,
  properties: {
    keyId: filled,
    keySecret: filled,
    webhookSecret: { ...filled, nullable: true },
    environment: { ...environment, nullable: true },
  },
});

/** A payment gateway's set-up. Secrets never leave the server. */
export interface GatewaySummary {
  provider: 'razorpay' | 'cashfree';
  configured: boolean;
  enabled: boolean;
  keyId: string | null;
  environment: 'sandbox' | 'production' | null;
}

export const gatewayListResponse: JSONSchemaType<GatewaySummary[]> = {
  type: 'array',
  items: {
    type: 'object',
    required: ['provider', 'configured', 'enabled', 'keyId', 'environment'],
    additionalProperties: false,
    properties: {
      provider: { type: 'string', enum: ['razorpay', 'cashfree'] },
      configured: { type: 'boolean' },
      enabled: { type: 'boolean' },
      keyId: { anyOf: [{ type: 'string' }, { type: 'null', nullable: true }] },
      environment: { anyOf: [environment, { type: 'null', nullable: true }] },
    },
  },
};
