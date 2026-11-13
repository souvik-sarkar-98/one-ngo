import type { FastifyRequest } from 'fastify';

/** The request's `Origin` when it is one of the allowed cross-site origins. */
export function crossSiteOrigin(req: FastifyRequest, allowedOrigins: ReadonlySet<string>): string | undefined {
  const origin = req.headers.origin;
  return typeof origin === 'string' && allowedOrigins.has(origin) ? origin : undefined;
}
