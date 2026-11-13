import { schemaOf } from './schema.js';

export interface FieldIssue {
  /** JSON Pointer to the part of the body, such as `/roles/0`; `/` is the whole body. */
  path: string;
  message: string;
}

/**
 * Every error answer. `bad_request` (400) means the body has the wrong shape:
 * a field is missing, has the wrong type or is not part of the request.
 * Valid input the platform refuses is 422 with its own code.
 */
export interface ErrorResponse {
  code: string;
  message: string;
  issues?: FieldIssue[];
  /** The screen-text key for `message`, where the app ships one, so the reader sees it in their language. */
  textKey?: string;
  /** Only on 500 answers, to quote when reporting the problem. */
  requestId?: string;
}

export const errorResponse = schemaOf<ErrorResponse>({
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    issues: {
      type: 'array',
      nullable: true,
      items: { type: 'object', required: ['path', 'message'], properties: { path: { type: 'string' }, message: { type: 'string' } } },
    },
    textKey: { type: 'string', nullable: true },
    requestId: { type: 'string', nullable: true },
  },
});
