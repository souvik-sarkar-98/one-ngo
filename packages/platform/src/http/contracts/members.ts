import { schemaOf } from './schema.js';

export interface AddMemberRequest {
  email: string;
  /** The name this organisation knows them by; needed even when the email already has an account elsewhere. */
  displayName?: string;
  roles?: string[];
  invite?: boolean;
}

export const addMemberRequest = schemaOf<AddMemberRequest>({
  type: 'object',
  required: ['email'],
  additionalProperties: false,
  properties: {
    email: { type: 'string' },
    displayName: { type: 'string', nullable: true },
    roles: { type: 'array', nullable: true, items: { type: 'string' } },
    invite: { type: 'boolean', nullable: true },
  },
});

/** Replaces the member's roles. */
export interface MemberRolesRequest {
  roles: string[];
}

export const memberRolesRequest = schemaOf<MemberRolesRequest>({
  type: 'object',
  required: ['roles'],
  additionalProperties: false,
  properties: { roles: { type: 'array', items: { type: 'string' } } },
});
