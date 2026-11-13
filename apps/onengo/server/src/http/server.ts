import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { HttpDeps, HttpHost } from '@onengo/platform/main';
import { clientAddressKey, proxyTrust } from './client-address.js';
import { signIn } from './context.js';
import { crossSiteOrigin } from './cors.js';
import { errorHandler } from './errors.js';
import { bodyText, parseJsonBody } from './json-body.js';
import { adminRoutes } from './plugins/admin.js';
import { authRoutes } from './plugins/auth.js';
import { builderRoutes } from './plugins/builder.js';
import { fileRoutes } from './plugins/files.js';
import { internalRoutes } from './plugins/internal.js';
import { organisationRoutes, publicOrganisationRoutes } from './plugins/organisation.js';
import { dataFeedRoutes } from './plugins/data-feed.js';
import { publicFormRoutes } from './plugins/public-form.js';
import { publicReceiptRoutes } from './plugins/public-receipt.js';
import { paymentRoutes, webhookRoutes } from './plugins/payments.js';
import { privacyRoutes } from './plugins/privacy.js';
import { reportRoutes } from './plugins/reports.js';
import { migrationRoutes } from './plugins/migration.js';
import { recordRoutes } from './plugins/records.js';
import { sessionRoutes } from './plugins/session.js';
import { webAppRoutes } from './plugins/static.js';
import { validatorCompiler } from './validation.js';

export interface ServerOptions {
  /**
   * Test-only sign-in: tenant and actor are read from `x-dev-tenant` and
   * `x-dev-actor` headers. Allowed only when NODE_ENV is test.
   */
  devAuth?: boolean;
  /** Shared secret for POST /internal/tick from a scheduler other than App Engine cron. */
  tickSecret?: string;
  /** Accept App Engine's `X-Appengine-Cron` header (App Engine strips it from outside requests). */
  trustAppEngineCron?: boolean;
  /**
   * The proxies in front of this server, so the client address is read from
   * X-Forwarded-For past them and never further left (what a client sends
   * itself). A hop count (App Engine: 1, its front end) or the proxies'
   * addresses and CIDR ranges. Unset trusts nothing: the socket address is used.
   */
  trustProxy?: number | string[];
  /** Per client address per minute for the organisation sign-in page lookups (code and logo). */
  organisationLookupLimit?: number;
  /**
   * Browser origins allowed to call this API when the web app is hosted elsewhere.
   * Empty means same-origin only. A matching cross-site sign-in marks the refresh
   * cookie `SameSite=None; Secure` so the browser will store and send it.
   */
  corsOrigins?: string[];
  /** Folder with the built web app (index.html). Served at / with in-app routes falling back to index.html. */
  webRoot?: string;
  /** Built user-guide app, served at `/guide-app/` so the web app can frame it. */
  guideRoot?: string;
  /** Folder with definition JSON Schemas, exposed read-only to the builder. */
  schemaDir?: string;
  /** Requests per minute per client address, per instance. */
  rateLimits?: { api?: number; auth?: number; webhooks?: number };
}

/** Header sign-in is allowed only in test runs, never on a cloud host. */
export function assertDevAuthAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const onCloud = !!(env.GAE_SERVICE || env.K_SERVICE || env.GOOGLE_CLOUD_PROJECT || env.FUNCTION_TARGET);
  if (onCloud || env.NODE_ENV !== 'test') {
    throw new Error('Header sign-in cannot be enabled outside a test run.');
  }
}

function requestId(req: FastifyRequest): string {
  const trace = req.headers['x-cloud-trace-context'];
  const fromTrace = typeof trace === 'string' ? trace.split('/')[0] : undefined;
  return fromTrace && /^[0-9a-f]{16,32}$/i.test(fromTrace) ? fromTrace : randomUUID().replace(/-/g, '');
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(self)',
};

declare module 'fastify' {
  interface FastifyRequest {
    requestId?: string;
  }
}

const CORS_ALLOW_HEADERS = 'authorization, content-type, x-file-name, idempotency-key';
const CORS_EXPOSE_HEADERS = 'x-request-id, x-next-before, retry-after, content-disposition';

/**
 * The /api/auth/ addresses that offer no credential to guess: keeping a session
 * alive, signing out, and the organisation's own sign-in branding and install
 * manifest. One person moving quickly through the app makes many of these, so
 * they take the ordinary API budget instead of the much smaller sign-in one.
 * The branding lookups keep their own tighter per-address limit on top.
 */
const SESSION_AUTH_PATH = /^\/api\/auth\/(?:refresh|logout|organisations\/)/;

const KEY_PREFIX = { api: 'api', auth: 'auth', webhooks: 'hook' } as const;

type Budget = keyof typeof KEY_PREFIX;

/** Which per-address budget a request spends, or none for addresses that are not rate limited. */
export function budgetFor(path: string): Budget | null {
  if (path.startsWith('/api/auth/')) return SESSION_AUTH_PATH.test(path) ? 'api' : 'auth';
  if (path.startsWith('/webhooks/')) return 'webhooks';
  return path.startsWith('/api/') ? 'api' : null;
}

/** The route bundles to serve: pass `platform.http`; anything that carries them as `http` (a whole platform in tests) is accepted too. */
export function buildServer(host: HttpDeps | HttpHost, options: ServerOptions = {}): FastifyInstance {
  if (options.devAuth) assertDevAuthAllowed();
  const deps = 'http' in host ? host.http : host;
  const allowedOrigins = new Set(options.corsOrigins ?? []);
  const log = deps.server.logger;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: proxyTrust(options.trustProxy) });
  app.setValidatorCompiler(validatorCompiler);

  const limiters = {
    api: deps.server.rateLimiter(options.rateLimits?.api ?? 300, 60_000),
    auth: deps.server.rateLimiter(options.rateLimits?.auth ?? 30, 60_000),
    webhooks: deps.server.rateLimiter(options.rateLimits?.webhooks ?? 600, 60_000),
  };

  app.addHook('onRequest', async (req, reply) => {
    req.requestId = requestId(req);
    reply.header('x-request-id', req.requestId);
    const path = req.url.split('?')[0] ?? '';
    // A public site's origin is decided per organisation on the data feed, not by the process-wide list.
    const origin = path.startsWith('/api/data/') ? null : crossSiteOrigin(req, allowedOrigins);
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('access-control-expose-headers', CORS_EXPOSE_HEADERS);
      reply.header('vary', 'origin');
    }
    const budget = budgetFor(path);
    if (budget && !limiters[budget].hit(`${KEY_PREFIX[budget]}:${clientAddressKey(req.ip)}`)) {
      log.log('NOTICE', 'Rate limit reached', { trace: req.requestId, path, ip: req.ip });
      return reply.status(429).header('retry-after', '60').send({ code: 'rate_limited', message: 'Too many requests. Wait a minute and try again.' });
    }
    if (origin && req.method === 'OPTIONS') {
      return reply
        .status(204)
        .header('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE')
        .header('access-control-allow-headers', CORS_ALLOW_HEADERS)
        .header('access-control-max-age', '600')
        .send();
    }
  });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => parseJsonBody(bodyText(body), done));

  app.setErrorHandler(errorHandler(deps.errors));

  app.addHook('onResponse', async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') deps.server.kickOutbox();
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const path = req.url.split('?')[0] ?? '';
    const guide = path === '/guide-app' || path.startsWith('/guide-app/');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (guide && name === 'x-frame-options') continue;
      const header = guide && name === 'content-security-policy'
        ? value.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("frame-ancestors 'none'", "frame-ancestors 'self'")
        : value;
      reply.header(name, header);
    }
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    // Chrome drops an install icon it is not allowed to store, and draws a letter instead.
    const installIcon = /^\/api\/auth\/organisations\/[a-z0-9][a-z0-9-]{0,39}\/icon\/(?:180|192|512)$/.test(path);
    if (installIcon) reply.header('cache-control', 'public, max-age=86400');
    else if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.register(internalRoutes, { deps: deps.internal, tickSecret: options.tickSecret, trustAppEngineCron: options.trustAppEngineCron });
  app.register(authRoutes, { deps: deps.auth, corsOrigins: options.corsOrigins });
  const organisationLookup = deps.server.rateLimiter(options.organisationLookupLimit ?? 20, 60_000);
  app.register(publicOrganisationRoutes, { deps: deps.publicOrganisation, limiter: organisationLookup });
  app.register(publicReceiptRoutes, { deps: deps.publicReceipts, limiter: organisationLookup });
  app.register(publicFormRoutes, { deps: deps.publicForms, limiter: organisationLookup });
  app.register(dataFeedRoutes, { deps: deps.dataFeeds, limiter: organisationLookup });
  app.register(webhookRoutes, { deps: deps.webhooks });

  app.register(async (api) => {
    api.addHook('onRequest', signIn(deps.authenticator, options.devAuth));
    api.register(sessionRoutes, { deps: deps.session });
    api.register(recordRoutes, { deps: deps.records });
    api.register(builderRoutes, { deps: deps.builder, schemaDir: options.schemaDir });
    api.register(paymentRoutes, { deps: deps.payments });
    api.register(adminRoutes, { deps: deps.admin });
    api.register(organisationRoutes, { deps: deps.organisation });
    api.register(fileRoutes, { deps: deps.files });
    api.register(reportRoutes, { deps: deps.reports });
    api.register(migrationRoutes, { deps: deps.migration });
    api.register(privacyRoutes, { deps: deps.privacy });
  });

  app.register(webAppRoutes, { webRoot: options.webRoot, guideRoot: options.guideRoot });

  return app;
}
