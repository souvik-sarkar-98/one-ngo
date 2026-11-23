import { schemaOf } from './schema.js';

const text = { type: 'string' } as const;
const optionalText = { type: 'string', nullable: true } as const;
/** Rupees as a number or a decimal string such as "250.50". */
const amount = { type: ['number', 'string'] } as const;

export interface OpenAccountRequest {
  key: string;
  name: string;
  kind: 'bank' | 'cash' | 'wallet' | 'investment';
  /** An existing asset ledger account to attach to, such as BANK. Omit to create a new one. */
  ledgerCode?: string;
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
    ledgerCode: optionalText,
    holderUserId: optionalText,
    custodian: optionalText,
    upiId: optionalText,
    allowNegative: { type: 'boolean', nullable: true },
  },
});

/** Fields that may change after opening. The key, kind and ledger account cannot. An empty `upiId` or `custodian` clears it. */
export interface UpdateAccountRequest {
  name?: string;
  custodian?: string;
  upiId?: string;
  allowNegative?: boolean;
}

export const updateAccountRequest = schemaOf<UpdateAccountRequest>({
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    name: optionalText,
    custodian: optionalText,
    upiId: optionalText,
    allowNegative: { type: 'boolean', nullable: true },
  },
});

/** Lines of the bank's statement for one money account. Money in is positive, money out negative. */
export interface StatementImportRequest {
  lines: { date: string; amount: number | string; description: string; reference?: string }[];
}

export const statementImportRequest = schemaOf<StatementImportRequest>({
  type: 'object',
  required: ['lines'],
  additionalProperties: false,
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        required: ['date', 'amount', 'description'],
        additionalProperties: false,
        properties: { date: text, amount, description: text, reference: optionalText },
      },
    },
  },
});

export interface StatementMatchLineRequest {
  /** The ledger line to pair with. */
  journalLineId: string;
}

export const statementMatchLineRequest = schemaOf<StatementMatchLineRequest>({
  type: 'object',
  required: ['journalLineId'],
  additionalProperties: false,
  properties: { journalLineId: text },
});

export interface StatementIgnoreRequest {
  note: string;
}

export const statementIgnoreRequest = schemaOf<StatementIgnoreRequest>({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: { note: text },
});

export interface StatementBookRequest {
  /** The ledger account for the other side, such as BANK_CHARGES. */
  accountCode: string;
  memo?: string;
}

export const statementBookRequest = schemaOf<StatementBookRequest>({
  type: 'object',
  required: ['accountCode'],
  additionalProperties: false,
  properties: { accountCode: text, memo: optionalText },
});

export interface ReconciliationSignOffRequest {
  asOf: string;
  statementBalance: number | string;
  note?: string;
}

export const reconciliationSignOffRequest = schemaOf<ReconciliationSignOffRequest>({
  type: 'object',
  required: ['asOf', 'statementBalance'],
  additionalProperties: false,
  properties: { asOf: text, statementBalance: amount, note: optionalText },
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
