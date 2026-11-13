import { schemaOf } from './schema.js';

const permissions = { type: 'array', nullable: true, items: { type: 'string' } } as const;
const requireTwoStep = { type: 'boolean', nullable: true } as const;

export interface CreateRoleRequest {
  key: string;
  label: string;
  permissions?: string[];
  requireTwoStep?: boolean;
}

export const createRoleRequest = schemaOf<CreateRoleRequest>({
  type: 'object',
  required: ['key', 'label'],
  additionalProperties: false,
  properties: { key: { type: 'string' }, label: { type: 'string' }, permissions, requireTwoStep },
});

/** Changes only what is sent; the key cannot change. */
export interface UpdateRoleRequest {
  label?: string;
  permissions?: string[];
  requireTwoStep?: boolean;
}

export const updateRoleRequest = schemaOf<UpdateRoleRequest>({
  type: 'object',
  additionalProperties: false,
  properties: { label: { type: 'string', nullable: true }, permissions, requireTwoStep },
});

/** People to give the role to. */
export interface RoleMembersRequest {
  userIds: string[];
}

export const roleMembersRequest = schemaOf<RoleMembersRequest>({
  type: 'object',
  required: ['userIds'],
  additionalProperties: false,
  properties: { userIds: { type: 'array', items: { type: 'string' } } },
});
