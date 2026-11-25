import { schemaOf } from './schema.js';

/** The address of one data migration, for routes that take no body. */
export interface MigrationParams {
  id: string;
}

/** Coarse shape only; the service answers 404 for an id that is not a migration of the organisation. */
export const migrationParams = schemaOf<MigrationParams>({
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string' } },
});

/**
 * A file's mapping: { targets } for records (the default) or { kind: 'people', people }. Coarse shape only;
 * eadSourceMapping owns the deep rules and answers 422 with field paths.
 */
export interface MigrationMappingBody {
  kind?: string;
  targets?: Record<string, unknown>[];
  people?: Record<string, unknown>;
}

export const migrationMappingBody = schemaOf<MigrationMappingBody>({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', nullable: true },
    targets: { type: 'array', nullable: true, items: { type: 'object', required: [], additionalProperties: true } },
    people: { type: 'object', nullable: true, required: [], additionalProperties: true },
  },
});

/** The address of one attachment of a data migration. Coarse shape only; the service answers 404 for an unknown one. */
export interface MigrationAttachmentParams {
  id: string;
  attachmentId: string;
}

export const migrationAttachmentParams = schemaOf<MigrationAttachmentParams>({
  type: 'object',
  required: ['id', 'attachmentId'],
  additionalProperties: false,
  properties: { id: { type: 'string' }, attachmentId: { type: 'string' } },
});

/** `GET /api/migrations/:id/attachments`: `q` is a part of the path, any case; `limit` is 1 to 200 (default 50). */
export interface MigrationAttachmentsQuery {
  q?: string;
  limit?: number;
  offset?: number;
}

export const migrationAttachmentsQuery = schemaOf<MigrationAttachmentsQuery>({
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', nullable: true },
    limit: { type: 'integer', minimum: 1, maximum: 200, nullable: true },
    offset: { type: 'integer', minimum: 0, nullable: true },
  },
});
