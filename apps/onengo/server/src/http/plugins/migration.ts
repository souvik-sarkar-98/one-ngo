import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { validationFailed, type HttpDeps } from '@onengo/platform/main';
import {
  migrationAttachmentParams,
  migrationAttachmentsQuery,
  migrationMappingBody,
  migrationParams,
  type MigrationAttachmentParams,
  type MigrationAttachmentsQuery,
  type MigrationMappingBody,
  type MigrationParams,
} from '@onengo/platform/contracts';
import { contextOf } from '../context.js';
import { attachment } from '../download.js';

function decodeHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Data migrations: CSV files of another system, their mappings, order and books, the check, the run and the failed rows. */
export async function migrationRoutes(api: FastifyInstance, { deps }: { deps: HttpDeps['migration'] }): Promise<void> {
  const m = deps.migrations;

  api.get('/api/migrations', async (req) => m.list(contextOf(req)));
  /** { name } */
  api.post<{ Body: { name?: unknown } }>('/api/migrations', async (req, reply) => reply.status(201).send(await m.create(contextOf(req), req.body ?? {})));
  api.get<{ Params: { id: string } }>('/api/migrations/:id', async (req) => m.get(contextOf(req), req.params.id));

  /** One CSV of any columns, sent as the request body like a file upload; its name travels URI-encoded in `x-file-name`. */
  api.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    scope.post<{ Params: { id: string } }>('/api/migrations/:id/sources', async (req, reply) => {
      if (/^multipart\//i.test(req.headers['content-type'] ?? '')) throw validationFailed('Send the file itself as the request body, not a form.');
      const raw = req.headers['x-file-name'];
      const name = typeof raw === 'string' ? decodeHeader(raw) : 'file.csv';
      const body = (req.body as AsyncIterable<Buffer> | undefined) ?? [];
      return reply.status(201).send(await m.addSource(contextOf(req), req.params.id, body, name));
    });
    /** One attachment (a photo or scan a file column names), sent as the raw body; `x-file-name` is its URI-encoded relative path. Answers `{ count, bytes }`, the profile's totals. */
    scope.post<{ Params: MigrationParams }>('/api/migrations/:id/attachments', { schema: { params: migrationParams } }, async (req, reply) => {
      if (/^multipart\//i.test(req.headers['content-type'] ?? '')) throw validationFailed('Send the file itself as the request body, not a form.');
      const raw = req.headers['x-file-name'];
      const path = typeof raw === 'string' ? decodeHeader(raw) : '';
      const body = (req.body as AsyncIterable<Buffer> | undefined) ?? [];
      return reply.status(201).send(await m.addAttachment(contextOf(req), req.params.id, body, path));
    });
  });
  /** `?q=` a part of the path, `limit` (default 50, at most 200), `offset`. Answers `{ items: [{ id, path, size, mime, usedBy }], total }`. */
  api.get<{ Params: MigrationParams; Querystring: MigrationAttachmentsQuery }>(
    '/api/migrations/:id/attachments',
    { schema: { params: migrationParams, querystring: migrationAttachmentsQuery } },
    async (req) => m.attachments(contextOf(req), req.params.id, req.query),
  );
  /** Removes every attachment; the profile returns to draft. */
  api.delete<{ Params: MigrationParams }>('/api/migrations/:id/attachments', { schema: { params: migrationParams } }, async (req, reply) => {
    await m.clearAttachments(contextOf(req), req.params.id);
    return reply.status(204).send();
  });
  api.delete<{ Params: MigrationAttachmentParams }>('/api/migrations/:id/attachments/:attachmentId', { schema: { params: migrationAttachmentParams } }, async (req, reply) => {
    await m.removeAttachment(contextOf(req), req.params.id, req.params.attachmentId);
    return reply.status(204).send();
  });

  api.delete<{ Params: { id: string; sourceId: string } }>('/api/migrations/:id/sources/:sourceId', async (req) =>
    m.removeSource(contextOf(req), req.params.id, req.params.sourceId),
  );
  /**
   * Records: { targets: [{ key, type, oldId, fields: { <field>: <column> }, refs: { <field>: { column } | { target } }, required }] }
   * People: { kind: 'people', people: { oldId, email, name, roles?: { column, separator?, map? } | { fixed }, status?: { column, active, suspended }, locale? } }
   * A people file needs `data:migrate:people` and `members:manage`. 422 carries field paths such as `/people/roles/map/Admin`.
   */
  api.put<{ Params: { id: string; sourceId: string }; Body: MigrationMappingBody }>(
    '/api/migrations/:id/sources/:sourceId/mapping',
    { schema: { body: migrationMappingBody } },
    async (req) => m.setMapping(contextOf(req), req.params.id, req.params.sourceId, req.body ?? {}),
  );
  /** { sourceIds: [...] } listing every file once. */
  api.put<{ Params: { id: string }; Body: { sourceIds?: unknown } }>('/api/migrations/:id/order', async (req) => m.setOrder(contextOf(req), req.params.id, req.body ?? {}));
  /** { cutoverDate, lines: [{ accountCode, debit | credit }], receipts: [{ series, next }] } */
  api.put<{ Params: { id: string }; Body: unknown }>('/api/migrations/:id/books', async (req) => m.setBooks(contextOf(req), req.params.id, req.body ?? {}));
  api.post<{ Params: { id: string } }>('/api/migrations/:id/books/apply', async (req) => m.applyBooks(contextOf(req), req.params.id));
  api.post<{ Params: { id: string } }>('/api/migrations/:id/check', async (req) => m.check(contextOf(req), req.params.id));
  api.post<{ Params: { id: string } }>('/api/migrations/:id/run', async (req, reply) => reply.status(202).send(await m.run(contextOf(req), req.params.id)));
  api.post<{ Params: { id: string } }>('/api/migrations/:id/cancel', async (req) => m.cancel(contextOf(req), req.params.id));
  /** Deletes the source CSVs, column samples and failed-row cells; refused while running. Answers the profile view with `purgedAt`. */
  api.post<{ Params: MigrationParams }>('/api/migrations/:id/purge', { schema: { params: migrationParams } }, async (req) => m.purge(contextOf(req), req.params.id));

  api.get<{ Params: { id: string; sourceId: string } }>('/api/migrations/:id/sources/:sourceId/failed.csv', async (req, reply) => {
    const ctx = contextOf(req);
    const fileName = await m.fileName(ctx, req.params.id, req.params.sourceId);
    const lines = m.failedCsv(ctx, req.params.id, req.params.sourceId);
    const first = await lines.next();
    async function* all() {
      if (!first.done) yield first.value;
      yield* lines;
    }
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', attachment(`Failed rows - ${fileName}`))
      .header('x-content-type-options', 'nosniff')
      .send(Readable.from(all()));
  });
}
