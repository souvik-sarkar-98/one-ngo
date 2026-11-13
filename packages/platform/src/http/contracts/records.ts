import { schemaOf } from './schema.js';

/**
 * Record data, step values and action input. Only the envelope is fixed here:
 * the published definitions check what is inside, so a field published after
 * start-up is accepted at once.
 */
type Values = Record<string, unknown>;
const values = { type: 'object', required: [] } as const;
const optionalValues = { type: 'object', nullable: true, required: [] } as const;
const text = { type: 'string' } as const;
const optionalText = { type: 'string', nullable: true } as const;
const optionalNames = { type: 'array', nullable: true, items: text } as const;

/** Creating a record: the body is the record data itself. */
export type CreateRecordRequest = Values;

export const createRecordRequest = schemaOf<CreateRecordRequest>(values);

export interface UpdateRecordRequest {
  data: Values;
  /** The version the change was made from; another version answers 409. */
  expectedVersion: number;
}

export const updateRecordRequest = schemaOf<UpdateRecordRequest>({
  type: 'object',
  required: ['data', 'expectedVersion'],
  additionalProperties: false,
  properties: { data: values, expectedVersion: { type: 'integer' } },
});

export interface TransitionRequest {
  data?: Values;
  expectedVersion: number;
}

export const transitionRequest = schemaOf<TransitionRequest>({
  type: 'object',
  required: ['expectedVersion'],
  additionalProperties: false,
  properties: { data: optionalValues, expectedVersion: { type: 'integer' } },
});

export interface ActionRequest {
  input?: Values;
  /** Checked only when sent. */
  expectedVersion?: number;
}

export const actionRequest = schemaOf<ActionRequest>({
  type: 'object',
  additionalProperties: false,
  properties: { input: optionalValues, expectedVersion: { type: 'integer', nullable: true } },
});

/** One field's condition; dates are YYYY-MM-DD and bounds are inclusive. */
export interface FieldFilterRequest {
  in?: (string | number | boolean)[];
  eq?: string | number | boolean | null;
  from?: string | number | null;
  to?: string | number | null;
  /** Location fields: within `km` of a point. */
  near?: { lat: number; lng: number; km: number };
}

const point = { lat: { type: 'number' }, lng: { type: 'number' } } as const;

const fieldFilter = {
  type: 'object',
  additionalProperties: false,
  properties: {
    in: { type: 'array', nullable: true, items: { type: ['string', 'number', 'boolean'] } },
    eq: { nullable: true, anyOf: [{ type: ['string', 'number', 'boolean'] }, { type: 'null', nullable: true }] },
    from: { nullable: true, anyOf: [{ type: ['string', 'number'] }, { type: 'null', nullable: true }] },
    to: { nullable: true, anyOf: [{ type: ['string', 'number'] }, { type: 'null', nullable: true }] },
    near: { type: 'object', nullable: true, required: ['lat', 'lng', 'km'], additionalProperties: false, properties: { ...point, km: { type: 'number' } } },
  },
} as const;

/** Conditions every list, count and total shares, keyed by field or workflow key. */
interface RecordConditions {
  statusIn?: string[];
  /** Only records the signed-in person owns. */
  owner?: 'me';
  /** Only records shared with the signed-in person or one of their roles. */
  sharedWithMe?: boolean;
  filters?: Record<string, FieldFilterRequest>;
  /** States of any workflow of the record type, by workflow key. */
  states?: Record<string, string[]>;
}

const conditions = {
  statusIn: optionalNames,
  owner: { type: 'string', nullable: true, enum: ['me'] },
  sharedWithMe: { type: 'boolean', nullable: true },
  filters: { type: 'object', nullable: true, required: [], additionalProperties: fieldFilter },
  states: { type: 'object', nullable: true, required: [], additionalProperties: { type: 'array', items: text } },
} as const;

export interface RecordQueryRequest extends RecordConditions {
  search?: string;
  /** A field key, or number, status, createdAt, updatedAt; `from` sorts a location field nearest first. */
  sort?: { field: string; dir?: 'asc' | 'desc'; from?: { lat: number; lng: number } };
  /** Number or money fields to total over every match. */
  sum?: string[];
  limit?: number;
  offset?: number;
}

const recordQueryProperties = {
  ...conditions,
  search: optionalText,
  sort: {
    type: 'object',
    nullable: true,
    required: ['field'],
    additionalProperties: false,
    properties: {
      field: text,
      dir: { type: 'string', nullable: true, enum: ['asc', 'desc'] },
      from: { type: 'object', nullable: true, required: ['lat', 'lng'], additionalProperties: false, properties: point },
    },
  },
  sum: optionalNames,
  limit: { type: 'integer', nullable: true },
  offset: { type: 'integer', nullable: true },
} as const;

export const recordQueryRequest = schemaOf<RecordQueryRequest>({ type: 'object', additionalProperties: false, properties: recordQueryProperties });

export interface AggregateRequestBody extends RecordConditions {
  measure: 'count' | 'sum';
  /** The number or money field a sum adds up. */
  field?: string;
  /** Split by a choice, yes/no or reference field, or by period of a date. */
  groupBy?: { field: string } | { period: 'day' | 'week' | 'month' | 'financialYear'; dateField: string };
  /** The page widget asking; refused when the person cannot see it. */
  widget?: { page: string; index: number };
}

export const aggregateRequest = schemaOf<AggregateRequestBody>({
  type: 'object',
  required: ['measure'],
  additionalProperties: false,
  properties: {
    ...conditions,
    measure: { type: 'string', enum: ['count', 'sum'] },
    field: optionalText,
    groupBy: {
      type: 'object',
      nullable: true,
      oneOf: [
        { type: 'object', required: ['field'], additionalProperties: false, properties: { field: text } },
        {
          type: 'object',
          required: ['period', 'dateField'],
          additionalProperties: false,
          properties: { period: { type: 'string', enum: ['day', 'week', 'month', 'financialYear'] }, dateField: text },
        },
      ],
    },
    widget: { type: 'object', nullable: true, required: ['page', 'index'], additionalProperties: false, properties: { page: text, index: { type: 'integer' } } },
  },
});

export type BulkOperationRequest =
  | { type: 'edit'; values: Values }
  | { type: 'step'; step: string; data?: Values }
  | { type: 'action'; action: string; input?: Values }
  | { type: 'share'; principalKind: 'user' | 'role'; principal: string; access: 'read' | 'edit'; expiresAt?: string }
  | { type: 'export' };

/** One operation over the records named by `ids`, or over every record matching `query`; exactly one of the two. */
export interface BulkRequest {
  ids?: string[];
  query?: RecordQueryRequest;
  operation: BulkOperationRequest;
}

const kind = <K extends string>(k: K) => ({ type: 'string', const: k }) as const;

export const bulkRequest = schemaOf<BulkRequest>({
  type: 'object',
  required: ['operation'],
  additionalProperties: false,
  oneOf: [{ required: ['ids'] }, { required: ['query'] }],
  properties: {
    ids: { type: 'array', nullable: true, items: text },
    query: { type: 'object', nullable: true, additionalProperties: false, properties: recordQueryProperties },
    operation: {
      type: 'object',
      required: ['type'],
      discriminator: { propertyName: 'type' },
      oneOf: [
        { type: 'object', required: ['type', 'values'], additionalProperties: false, properties: { type: kind('edit'), values } },
        { type: 'object', required: ['type', 'step'], additionalProperties: false, properties: { type: kind('step'), step: text, data: optionalValues } },
        { type: 'object', required: ['type', 'action'], additionalProperties: false, properties: { type: kind('action'), action: text, input: optionalValues } },
        {
          type: 'object',
          required: ['type', 'principalKind', 'principal', 'access'],
          additionalProperties: false,
          properties: {
            type: kind('share'),
            principalKind: { type: 'string', enum: ['user', 'role'] },
            principal: text,
            access: { type: 'string', enum: ['read', 'edit'] },
            expiresAt: optionalText,
          },
        },
        { type: 'object', required: ['type'], additionalProperties: false, properties: { type: kind('export') } },
      ],
    },
  },
});
