import { schemaOf } from './schema.js';

const names = { type: 'array', nullable: true, items: { type: 'string' } } as const;

/** Approvals waiting for me. */
export interface ApprovalQueryRequest {
  search?: string;
  filters?: { type?: string[]; step?: string[]; requestedBy?: string[] };
  /** `waiting` orders by time waited: `desc` (the default) puts the longest waiting first. */
  sort?: { field: string; dir?: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

export const approvalQueryRequest = schemaOf<ApprovalQueryRequest>({
  type: 'object',
  additionalProperties: false,
  properties: {
    search: { type: 'string', nullable: true },
    filters: {
      type: 'object',
      nullable: true,
      additionalProperties: false,
      properties: { type: names, step: names, requestedBy: names },
    },
    sort: {
      type: 'object',
      nullable: true,
      required: ['field'],
      additionalProperties: false,
      properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'], nullable: true } },
    },
    limit: { type: 'integer', nullable: true },
    offset: { type: 'integer', nullable: true },
  },
});

export interface ApprovalDecisionRequest {
  decision: 'approve' | 'reject';
  comment?: string;
}

export const approvalDecisionRequest = schemaOf<ApprovalDecisionRequest>({
  type: 'object',
  required: ['decision'],
  additionalProperties: false,
  properties: { decision: { type: 'string', enum: ['approve', 'reject'] }, comment: { type: 'string', nullable: true } },
});
