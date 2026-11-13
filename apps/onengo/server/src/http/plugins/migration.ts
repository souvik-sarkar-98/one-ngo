import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { validationFailed, type HttpDeps } from '@onengo/platform/main';
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
  });

  api.delete<{ Params: { id: string; sourceId: string } }>('/api/migrations/:id/sources/:sourceId', async (req) =>
    m.removeSource(contextOf(req), req.params.id, req.params.sourceId),
  );
  /** { targets: [{ key, type, oldId, fields: { <field>: <column> }, refs: { <field>: { column } | { target } }, required }] } */
  api.put<{ Params: { id: string; sourceId: string }; Body: unknown }>('/api/migrations/:id/sources/:sourceId/mapping', async (req) =>
    m.setMapping(contextOf(req), req.params.id, req.params.sourceId, req.body ?? {}),
  );
  /** { sourceIds: [...] } listing every file once. */
  api.put<{ Params: { id: string }; Body: { sourceIds?: unknown } }>('/api/migrations/:id/order', async (req) => m.setOrder(contextOf(req), req.params.id, req.body ?? {}));
  /** { cutoverDate, lines: [{ accountCode, debit | credit }], receipts: [{ series, next }] } */
  api.put<{ Params: { id: string }; Body: unknown }>('/api/migrations/:id/books', async (req) => m.setBooks(contextOf(req), req.params.id, req.body ?? {}));
  api.post<{ Params: { id: string } }>('/api/migrations/:id/books/apply', async (req) => m.applyBooks(contextOf(req), req.params.id));
  api.post<{ Params: { id: string } }>('/api/migrations/:id/check', async (req) => m.check(contextOf(req), req.params.id));
  api.post<{ Params: { id: string } }>('/api/migrations/:id/run', async (req, reply) => reply.status(202).send(await m.run(contextOf(req), req.params.id)));
  api.post<{ Params: { id: string } }>('/api/migrations/:id/cancel', async (req) => m.cancel(contextOf(req), req.params.id));

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
