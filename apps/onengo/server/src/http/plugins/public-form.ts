import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { HttpDeps } from '@onengo/platform/main';
import { clientAddressKey } from '../client-address.js';
import { ORGANISATION_LOOKUP_FLOOR_MS } from './organisation.js';

type PublicForms = HttpDeps['publicForms'];

/**
 * A public form, catalogue search, and the secret link to one submission.
 * Unknown organisations, types and tokens take the same time to answer, and
 * the lookup shares the sign-in page's per-address limit.
 */
export async function publicFormRoutes(
  app: FastifyInstance,
  { deps, limiter }: { deps: PublicForms; limiter: { hit(key: string): boolean } },
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

  app.get<{ Params: { code: string; type: string } }>('/api/public/forms/:code/:type', async (req, reply) =>
    uniform(req, reply, () => deps.form(req.params.code, req.params.type)),
  );
  app.post<{ Params: { code: string; type: string }; Body: unknown }>('/api/public/forms/:code/:type', async (req, reply) =>
    uniform(req, reply, async () => reply.status(201).send(await deps.submit(req.params.code, req.params.type, req.body ?? {}))),
  );
  app.get<{ Params: { code: string; type: string }; Querystring: { q?: string } }>('/api/public/catalogue/:code/:type', async (req, reply) =>
    uniform(req, reply, () => deps.catalogue(req.params.code, req.params.type, req.query.q ?? '')),
  );
  app.get<{ Params: { token: string } }>('/api/public/records/:token', async (req, reply) => uniform(req, reply, () => deps.open(req.params.token)));
  app.patch<{ Params: { token: string }; Body: { values?: unknown; expectedVersion?: number } }>('/api/public/records/:token', async (req, reply) =>
    uniform(req, reply, () => deps.change(req.params.token, req.body?.values ?? {}, Number(req.body?.expectedVersion))),
  );
  app.delete<{ Params: { token: string }; Querystring: { version?: string } }>('/api/public/records/:token', async (req, reply) =>
    uniform(req, reply, async () => {
      await deps.remove(req.params.token, Number(req.query.version));
      return reply.status(204).send();
    }),
  );
}
