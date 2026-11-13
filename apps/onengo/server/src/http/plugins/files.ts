import { PassThrough, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { recordQueryOf, validationFailed, type FilesApi } from '@onengo/platform/main';
import { contextOf, requirePermission } from '../context.js';
import { attachment } from '../download.js';

function decodeHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Uploads and downloads, CSV imports and exports, their jobs, storage use and the whole-NGO export. Signed-in scope only. */
export async function fileRoutes(api: FastifyInstance, { deps }: { deps: FilesApi }): Promise<void> {
  const log = deps.logger;

  /** The file itself is the request body, streamed; its name travels URI-encoded in `x-file-name`. */
  api.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    scope.post<{ Querystring: { type?: string; field?: string } }>('/api/files', async (req, reply) => {
      const ctx = contextOf(req);
      if (/^multipart\//i.test(req.headers['content-type'] ?? '')) {
        throw validationFailed('Send the file itself as the request body, not a form.');
      }
      const raw = req.headers['x-file-name'];
      const name = typeof raw === 'string' ? decodeHeader(raw) : 'file';
      const body = (req.body as AsyncIterable<Buffer> | undefined) ?? [];
      const file = await deps.files.upload(ctx, { body, name, recordType: req.query.type, field: req.query.field });
      return reply.status(201).send(file);
    });
    /** A CSV of at most 10 MB and 20,000 rows, sent like a file upload. */
    scope.post<{ Params: { type: string } }>('/api/records/:type/imports', async (req, reply) => {
      const ctx = contextOf(req);
      if (/^multipart\//i.test(req.headers['content-type'] ?? '')) {
        throw validationFailed('Send the file itself as the request body, not a form.');
      }
      const raw = req.headers['x-file-name'];
      const name = typeof raw === 'string' ? decodeHeader(raw) : 'import.csv';
      const body = (req.body as AsyncIterable<Buffer> | undefined) ?? [];
      return reply.status(201).send(await deps.imports.upload(ctx, req.params.type, body, name));
    });
  });

  api.get<{ Params: { id: string } }>('/api/imports/:id', async (req) => deps.imports.get(contextOf(req), req.params.id));
  /** { columns: { <column>: <field key> | null }, updateBy?: <unique field key>, quiet?: boolean } */
  api.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/imports/:id/mapping', async (req) =>
    deps.imports.setMapping(contextOf(req), req.params.id, req.body ?? {}),
  );
  api.post<{ Params: { id: string } }>('/api/imports/:id/check', async (req) => deps.imports.check(contextOf(req), req.params.id));
  api.post<{ Params: { id: string } }>('/api/imports/:id/run', async (req, reply) =>
    reply.status(202).send(await deps.imports.run(contextOf(req), req.params.id)),
  );
  api.get<{ Params: { id: string } }>('/api/imports/:id/failed.csv', async (req, reply) => {
    const ctx = contextOf(req);
    const view = await deps.imports.get(ctx, req.params.id);
    const lines = deps.imports.failedCsv(ctx, view.id);
    const first = await lines.next();
    async function* all() {
      if (!first.done) yield first.value;
      yield* lines;
    }
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', attachment(`Failed rows - ${view.fileName}`))
      .header('x-content-type-options', 'nosniff')
      .send(Readable.from(all()));
  });

  /** CSV of the list: `q` is the query body as base64url JSON. 202 with the job when there are more rows than an export streams at once. */
  api.get<{ Params: { type: string }; Querystring: { q?: string } }>('/api/records/:type/export.csv', async (req, reply) => {
    const ctx = contextOf(req);
    let body: unknown = {};
    if (req.query.q) {
      try {
        body = JSON.parse(Buffer.from(req.query.q, 'base64url').toString('utf8'));
      } catch {
        throw validationFailed('q must be the list query as base64url JSON.');
      }
    }
    const out = await deps.exports.start(ctx, req.params.type, recordQueryOf(body));
    if ('jobId' in out) return reply.status(202).send(out);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', attachment(out.fileName))
      .header('x-content-type-options', 'nosniff')
      .send(Readable.from(out.lines));
  });

  api.get<{ Params: { id: string } }>('/api/jobs/:id', async (req) => deps.jobs.get(contextOf(req), req.params.id));
  api.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string; offset?: string } }>('/api/jobs/:id/items', async (req) => {
    const status = req.query.status;
    if (status !== undefined && status !== 'done' && status !== 'failed' && status !== 'skipped') {
      throw validationFailed("status must be 'done', 'failed' or 'skipped'.");
    }
    return deps.jobs.items(contextOf(req), req.params.id, {
      status,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
  });
  api.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => deps.jobs.cancel(contextOf(req), req.params.id));

  api.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const { file, body } = await deps.files.open(contextOf(req), req.params.id);
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
    return reply
      .type(file.mime)
      .header('content-length', file.size)
      .header('content-disposition', `${deps.opensInline(file.mime) ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });

  api.get('/api/admin/storage', async (req) => deps.files.usage(contextOf(req)));

  /** The whole NGO as gzipped JSON lines: for leaving the platform, moving installations, or backups. */
  api.get('/api/admin/export', { onRequest: requirePermission('data:export') }, async (req, reply) => {
    const ctx = contextOf(req);
    await deps.tenantExport.audit(ctx);
    const out = new PassThrough();
    const gzip = createGzip();
    gzip.pipe(out);
    const write = (line: string) =>
      new Promise<void>((resolve, reject) => {
        if (gzip.write(`${line}\n`)) resolve();
        else gzip.once('drain', resolve).once('error', reject);
      });
    deps.tenantExport
      .stream(ctx.tenantId, write)
      .then(() => gzip.end())
      .catch((error) => {
        log.log('ERROR', 'Export failed', { trace: req.requestId, tenantId: ctx.tenantId }, error);
        gzip.destroy(error as Error);
        out.destroy(error as Error);
      });
    const day = new Date().toISOString().slice(0, 10);
    return reply
      .type('application/gzip')
      .header('content-disposition', `attachment; filename="ngo-export-${day}.jsonl.gz"`)
      .send(out);
  });
}
