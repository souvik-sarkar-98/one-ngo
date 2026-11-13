import { schemaOf } from './schema.js';

/** A definition draft: the whole definition body, open here and checked against its kind's schema when saved and published. */
export interface DraftRequest {
  /** Must match the key in the address. */
  key: string;
}

export const draftRequest = schemaOf<DraftRequest>({
  type: 'object',
  required: ['key'],
  properties: { key: { type: 'string' } },
});

/** Changes to a shipped definition, merged over the module's version. */
export interface ExtensionPatchRequest {
  patch: Record<string, unknown>;
}

export const extensionPatchRequest = schemaOf<ExtensionPatchRequest>({
  type: 'object',
  required: ['patch'],
  additionalProperties: false,
  properties: { patch: { type: 'object', required: [] } },
});

/** Republishes an earlier published version as the newest. */
export interface RollbackRequest {
  version: number;
}

export const rollbackRequest = schemaOf<RollbackRequest>({
  type: 'object',
  required: ['version'],
  additionalProperties: false,
  properties: { version: { type: 'integer' } },
});
