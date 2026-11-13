import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Idempotency, RequestContext } from '@onengo/platform/main';

/**
 * Sends `run()`'s result with `status`. With an idempotency key the first
 * response is kept and repeated for the same request and key.
 */
export async function sendOnce(
  store: Idempotency,
  key: string | string[] | undefined,
  ctx: RequestContext,
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  run: () => Promise<unknown>,
): Promise<FastifyReply> {
  if (Array.isArray(key)) key = key[0];
  if (key === undefined) return reply.status(status).send(await run());
  const hash = store.requestHash(req.method, req.url.split('?')[0] ?? '', req.body ?? null);
  const out = await store.run(ctx, key, hash, async () => ({ status, body: await run() }));
  if (out.replayed) reply.header('idempotent-replayed', 'true');
  return reply.status(out.status).send(out.body);
}
