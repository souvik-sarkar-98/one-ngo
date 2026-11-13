import type { FastifyRequest } from 'fastify';
import { demand, forbidden, type Authenticator, type RequestActor, type RequestContext } from '@onengo/platform/main';

declare module 'fastify' {
  interface FastifyRequest {
    tenantContext?: RequestContext;
  }
}

/**
 * `onRequest` hook for the signed-in scope: a Bearer token, an API key, or (test runs only)
 * the `x-dev-tenant` and `x-dev-actor` headers become the request's TenantContext before its body is read.
 */
export function signIn(authenticator: Authenticator, devAuth = false) {
  return async (req: FastifyRequest): Promise<void> => {
    req.tenantContext = await resolve(authenticator, devAuth, req);
  };
}

async function resolve(authenticator: Authenticator, devAuth: boolean, req: FastifyRequest): Promise<RequestContext> {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return authenticator.bearer(auth.slice(7));
  if (auth?.startsWith('ApiKey ')) return authenticator.apiKey(auth.slice(7).trim());
  if (devAuth) {
    const tenantId = req.headers['x-dev-tenant'];
    const actor = req.headers['x-dev-actor'];
    if (typeof tenantId === 'string' && typeof actor === 'string') return { tenantId, actor: JSON.parse(actor) as RequestActor };
  }
  throw forbidden('Sign in first.');
}

/** The caller's TenantContext; refuses a route registered outside the signed-in scope. */
export function contextOf(req: FastifyRequest): RequestContext {
  if (!req.tenantContext) throw forbidden('Sign in first.');
  return req.tenantContext;
}

/** Route `onRequest` hook for a route that checks a permission itself rather than through a service. */
export function requirePermission(permission: string) {
  return async (req: FastifyRequest): Promise<void> => {
    demand(contextOf(req).actor, permission);
  };
}
