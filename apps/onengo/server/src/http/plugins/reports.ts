import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { HttpDeps } from '@onengo/platform/main';
import { contextOf } from '../context.js';
import { attachment } from '../download.js';

/** Reports the person may run, a preview that keeps nothing, and the files kept when a report is published. */
export async function reportRoutes(api: FastifyInstance, { deps }: { deps: HttpDeps['reports'] }): Promise<void> {
  api.get('/api/reports', async (req) => ({ reports: await deps.reports.list(contextOf(req)) }));

  api.get<{ Params: { key: string } }>('/api/reports/:key', async (req) => deps.reports.report(contextOf(req), req.params.key));

  api.get<{ Params: { id: string } }>('/api/reports/published/:id/file', async (req, reply) => {
    const out = await deps.reports.downloadPublished(contextOf(req), req.params.id);
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', attachment(out.fileName))
      .header('x-content-type-options', 'nosniff')
      .send(Readable.from([out.bytes]));
  });

  api.get<{ Params: { id: string } }>('/api/reports/published/:id', async (req) => deps.reports.getPublished(contextOf(req), req.params.id));

  api.post<{ Params: { key: string }; Body: { params?: unknown } }>('/api/reports/:key/preview', async (req) =>
    deps.reports.preview(contextOf(req), req.params.key, req.body?.params),
  );

  api.post<{ Params: { key: string }; Body: { params?: unknown; title?: unknown } }>('/api/reports/:key/publish', async (req) =>
    deps.reports.publish(contextOf(req), req.params.key, req.body),
  );

  api.post<{ Params: { key: string }; Querystring: { format?: string }; Body: { params?: unknown } }>('/api/reports/:key/run', async (req, reply) => {
    const out = await deps.reports.run(contextOf(req), req.params.key, req.body?.params);
    if ('jobId' in out) return reply.status(202).send(out);
    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', attachment(out.fileName))
      .header('x-content-type-options', 'nosniff')
      .send(Readable.from([out.bytes]));
  });
}
