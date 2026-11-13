import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { InternalApi } from '@onengo/platform/main';
import type { ServerOptions } from '../server.js';

/** Host probes and the scheduler tick: public, the tick guarded by its own secret or App Engine's cron header. */
export async function internalRoutes(
  app: FastifyInstance,
  { deps, tickSecret, trustAppEngineCron }: { deps: InternalApi } & Pick<ServerOptions, 'tickSecret' | 'trustAppEngineCron'>,
): Promise<void> {
  const log = deps.logger;

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => ((await deps.readiness.isReady()) ? { status: 'ready' } : reply.status(503).send({ status: 'unavailable' })));

  const fromCron = (req: FastifyRequest) => !!trustAppEngineCron && req.headers['x-appengine-cron'] === 'true';
  const refuse = (req: FastifyRequest, reply: FastifyReply) => {
    log.log('WARNING', 'Scheduler tick refused', { trace: req.requestId, ip: req.ip });
    return reply.status(403).send({ code: 'forbidden', message: 'Not allowed.' });
  };
  const tick = async (req: FastifyRequest) => {
    const result = await deps.scheduler.run();
    log.log('INFO', 'Scheduler tick', {
      trace: req.requestId,
      tenants: result.automations.tenants,
      records: result.automations.recordsProcessed,
      incomplete: result.automations.incomplete,
      dispatched: result.dispatch.processed,
      failed: result.dispatch.failed,
    });
    return result;
  };

  app.post('/internal/tick', async (req, reply) => {
    const auth = req.headers.authorization;
    const bySecret = !!tickSecret && !!auth && deps.safeEqual(auth, `Bearer ${tickSecret}`);
    return fromCron(req) || bySecret ? tick(req) : refuse(req, reply);
  });
  // App Engine cron sends GET. The bearer secret stays POST-only so it is never sent on a cacheable request.
  app.get('/internal/tick', { exposeHeadRoute: false }, async (req, reply) => (fromCron(req) ? tick(req) : refuse(req, reply)));
}
