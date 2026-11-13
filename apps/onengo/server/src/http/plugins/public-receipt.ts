import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PublicReceipts } from '@onengo/platform/main';
import { clientAddressKey } from '../client-address.js';
import { ORGANISATION_LOOKUP_FLOOR_MS } from './organisation.js';

function sendImage(reply: FastifyReply, image: Awaited<ReturnType<PublicReceipts['image']>>, filename: string) {
  return reply
    .type(image.file.mime)
    .header('content-length', image.file.size)
    .header('content-disposition', `inline; filename="${filename}"`)
    .header('x-content-type-options', 'nosniff')
    .send(image.body);
}

/**
 * A receipt opened with its public token. Unknown, revoked and malformed
 * tokens take the same time to answer, and the lookup shares the sign-in
 * page's per-address limit.
 */
export async function publicReceiptRoutes(
  app: FastifyInstance,
  { deps, limiter }: { deps: PublicReceipts; limiter: { hit(key: string): boolean } },
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
  app.get<{ Params: { token: string } }>('/api/public/receipts/:token', async (req, reply) => uniform(req, reply, () => deps.view(req.params.token)));
  app.get<{ Params: { token: string } }>('/api/public/receipts/:token/logo', async (req, reply) =>
    uniform(req, reply, async () => sendImage(reply, await deps.image(req.params.token, 'logo'), 'logo')),
  );
  app.get<{ Params: { token: string } }>('/api/public/receipts/:token/signature', async (req, reply) =>
    uniform(req, reply, async () => sendImage(reply, await deps.image(req.params.token, 'signature'), 'signature')),
  );
}
