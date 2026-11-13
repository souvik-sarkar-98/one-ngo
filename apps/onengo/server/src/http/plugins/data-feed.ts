import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { asApplicationError, type HttpDeps } from '@onengo/platform/main';
import { clientAddressKey } from '../client-address.js';
import { ORGANISATION_LOOKUP_FLOOR_MS } from './organisation.js';

type DataFeeds = HttpDeps['dataFeeds'];

const INVALID = { code: 'forbidden', message: 'This API key is not valid.', issues: [] };
const ORIGIN = { code: 'forbidden', message: "This site cannot read this organisation's data feeds.", issues: [] };

/**
 * A published data feed. The caller presents an API key bound to that feed.
 * A browser is allowed only when its origin is on the organisation's list.
 * The process-wide CORS list does not apply here.
 */
export async function dataFeedRoutes(
  app: FastifyInstance,
  { deps, limiter }: { deps: DataFeeds; limiter: { hit(key: string): boolean } },
): Promise<void> {
  const uniform = async <T>(req: FastifyRequest, reply: FastifyReply, answer: () => Promise<T>): Promise<T | FastifyReply> => {
    if (!limiter.hit(`org:${clientAddressKey(req.ip)}`)) {
      return reply.status(429).header('retry-after', '60').send({ code: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' });
    }
    const until = Date.now() + ORGANISATION_LOOKUP_FLOOR_MS;
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
    try {
      const value = await answer();
      await settle();
      return value;
    } catch (error) {
      await settle();
      throw error;
    }
  };

  app.route<{ Params: { code: string; feed: string }; Querystring: Record<string, unknown> }>({
    method: ['GET', 'OPTIONS'],
    url: '/api/data/:code/:feed',
    handler: async (req, reply) =>
      uniform(req, reply, async () => {
        const access = await deps.access(req.params.code);
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        if (origin) {
          if (!access.origins.includes(origin)) return reply.status(403).send(ORIGIN);
          reply.header('access-control-allow-origin', origin);
          reply.header('access-control-allow-methods', 'GET');
          reply.header('access-control-allow-headers', 'authorization');
          reply.header('vary', 'origin');
        } else if (req.method === 'OPTIONS') {
          return reply.status(403).send(ORIGIN);
        }
        await deps.published(access.tenantId, req.params.feed);
        if (req.method === 'OPTIONS') return reply.status(204).send();
        const header = req.headers.authorization;
        const credential = typeof header === 'string' && header.startsWith('ApiKey ') ? header.slice('ApiKey '.length).trim() : '';
        if (!credential) return reply.status(401).send(INVALID);
        try {
          await deps.authenticate(credential, access.tenantId, req.params.feed);
        } catch (error) {
          const known = asApplicationError(error);
          if (known?.code === 'forbidden') return reply.status(401).send({ code: 'forbidden', message: known.message, issues: known.issues });
          throw error;
        }
        return deps.read(access.tenantId, req.params.feed, req.query);
      }),
  });
}
