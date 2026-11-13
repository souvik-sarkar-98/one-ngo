import type { ConsentInput, ErasureInput } from '../../application/privacy/http-api.js';
import { schemaOf } from './schema.js';

const SUBJECT_KINDS = ['record', 'member'] as const;

/** One consent event: a purpose granted or withdrawn by a record (a donor) or a member. */
export type RecordConsentRequest = ConsentInput;

export const recordConsentRequest = schemaOf<RecordConsentRequest>({
  type: 'object',
  required: ['subjectKind', 'subjectId', 'purpose', 'state', 'source'],
  additionalProperties: false,
  properties: {
    subjectKind: { type: 'string', enum: [...SUBJECT_KINDS] },
    subjectId: { type: 'string' },
    purpose: { type: 'string' },
    state: { type: 'string', enum: ['granted', 'withdrawn'] },
    source: { type: 'string', enum: ['form', 'paper', 'email', 'phone', 'in_person', 'import', 'api'] },
  },
});

/** Erases a data subject by pseudonymisation; asking again returns the first result. */
export type EraseSubjectRequest = ErasureInput;

export const eraseSubjectRequest = schemaOf<EraseSubjectRequest>({
  type: 'object',
  required: ['subjectKind', 'subjectId'],
  additionalProperties: false,
  properties: {
    subjectKind: { type: 'string', enum: [...SUBJECT_KINDS] },
    subjectId: { type: 'string' },
    reason: { type: 'string', nullable: true, enum: ['subject_request', 'consent_withdrawn', 'other'] },
  },
});
