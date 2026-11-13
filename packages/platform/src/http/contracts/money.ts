import { schemaOf } from './schema.js';

const text = { type: 'string' } as const;
const optionalText = { type: 'string', nullable: true } as const;
/** Rupees as a number or a decimal string such as "250.50". */
const amount = { type: ['number', 'string'] } as const;

export interface OpenAccountRequest {
  key: string;
  name: string;
  kind: 'bank' | 'cash' | 'wallet' | 'investment';
  holderUserId?: string;
  custodian?: string;
  upiId?: string;
  allowNegative?: boolean;
}

export const openAccountRequest = schemaOf<OpenAccountRequest>({
  type: 'object',
  required: ['key', 'name', 'kind'],
  additionalProperties: false,
  properties: {
    key: text,
    name: text,
    kind: { type: 'string', enum: ['bank', 'cash', 'wallet', 'investment'] },
    holderUserId: optionalText,
    custodian: optionalText,
    upiId: optionalText,
    allowNegative: { type: 'boolean', nullable: true },
  },
});

export interface TransferRequest {
  /** Account keys. */
  from: string;
  to: string;
  amount: number | string;
  date: string;
  reference?: string;
}

export const transferRequest = schemaOf<TransferRequest>({
  type: 'object',
  required: ['from', 'to', 'amount', 'date'],
  additionalProperties: false,
  properties: { from: text, to: text, amount, date: text, reference: optionalText },
});

/**
 * A payment request through a published record action with a `createPayment`
 * step. The action decides the amount, provider, account and paid step.
 */
export interface CreatePaymentRequest {
  recordId: string;
  /** The action's key. */
  action: string;
  /** Values for the action's form, if it has one. */
  input?: Record<string, unknown>;
}

export const createPaymentRequest = schemaOf<CreatePaymentRequest>({
  type: 'object',
  required: ['recordId', 'action'],
  additionalProperties: false,
  properties: {
    recordId: text,
    action: text,
    input: { type: 'object', nullable: true, required: [] },
  },
});

export interface ConfirmPaymentRequest {
  paidOn: string;
  bankReference?: string;
}

export const confirmPaymentRequest = schemaOf<ConfirmPaymentRequest>({
  type: 'object',
  required: ['paidOn'],
  additionalProperties: false,
  properties: { paidOn: text, bankReference: optionalText },
});

export interface StatementMatchRequest {
  lines: { date: string; amount: number | string; description: string }[];
}

export const statementMatchRequest = schemaOf<StatementMatchRequest>({
  type: 'object',
  required: ['lines'],
  additionalProperties: false,
  properties: {
    lines: {
      type: 'array',
      items: { type: 'object', required: ['date', 'amount', 'description'], additionalProperties: false, properties: { date: text, amount, description: text } },
    },
  },
});
