import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { SCHEMA_DIR } from '../src/platform.js';
import { clerk, completeIdentity, createWorld, type TestWorld } from './helpers.js';

interface Route {
  method: HTTPMethods;
  path: string;
}

/**
 * Routes a signed-out caller must reach, by exact method and path. HEAD follows GET because
 * Fastify adds it to every GET route. Anything else must refuse a caller who has not signed in.
 */
const PUBLIC: Record<string, string> = {
  'GET /health': 'Liveness probe for the host; answers only { status: ok }.',
  'GET /ready': 'Readiness probe for the host; answers only whether the database responds, with no detail.',
  'GET /': 'The web app shell; it holds no data and signs in through the API.',
  'GET /index.html': 'The web app shell under its own name.',
  'POST /api/auth/login': 'Signing in with email and password.',
  'POST /api/auth/email-code/request': 'Asking for a sign-in code by email; answers the same whether or not the address is a member.',
  'POST /api/auth/email-code/verify': 'Signing in with the emailed code.',
  'POST /api/auth/two-step/complete': 'Second step of signing in, carried by the ticket the first step issued.',
  'GET /api/auth/passkey/available': 'Whether an organisation’s sign-in page offers passkeys; answers the same for unknown organisations.',
  'POST /api/auth/passkey/options': 'Starts a usernameless passkey sign-in. No account is looked up, so the answer reveals nothing about members.',
  'POST /api/auth/passkey/sign-in': 'Completes a passkey sign-in with the authenticator’s signed response, carried by its single-use challenge.',
  'POST /api/auth/refresh': 'A new access token from the refresh cookie, which is the credential.',
  'POST /api/auth/logout': 'Signing out clears the refresh cookie even when the session has already expired.',
  'POST /api/auth/password-reset/request': 'Asking for a reset link; answers the same whether or not the address is a member.',
  'POST /api/auth/password-reset/check': 'Whether an invitation or reset link still works, so its page can say so before asking for a password; the token is the credential and asking does not use it up.',
  'POST /api/auth/password-reset/complete': 'Setting a password from an invitation or reset link, carried by its single-use token.',
  'GET /api/auth/providers': 'The sign-in buttons (Google, Microsoft…) an organisation offers on its sign-in page.',
  'GET /api/auth/oidc/:provider/start': 'Sends the browser to the identity provider.',
  'GET /api/auth/oidc/callback': 'Where the identity provider sends the browser back, carrying its own signed state.',
  'GET /api/auth/organisations/:code': 'The organisation sign-in page: an active organisation’s display name, logo address, published theme colours and sign-in buttons; the same 404 otherwise.',
  'GET /api/auth/organisations/:code/logo': 'The logo on that sign-in page, for active organisations only.',
  'GET /api/auth/organisations/:code/icon/:size': 'The square home-screen icon: the organisation logo fitted into a square, or the shared heart when it has none. Chrome can store it. The same 404 otherwise.',
  'GET /api/auth/organisations/:code/manifest.webmanifest': 'The install manifest for that organisation. Its start page is the organisation sign-in page; the same 404 otherwise.',
  'GET /api/public/receipts/:token': 'A receipt opened from its public link; unknown, revoked and other-organisation links get the same 404.',
  'GET /api/public/receipts/:token/logo': 'The logo on a public receipt, for a live link only.',
  'GET /api/public/receipts/:token/signature': 'The signature image on a public receipt, for a live link only.',
  'GET /api/public/forms/:code/:type': 'The public form for one record type. Unknown organisations and types with create off get the same 404.',
  'POST /api/public/forms/:code/:type': 'Submits that form. Returns a secret link only when view is on.',
  'GET /api/public/catalogue/:code/:type': 'Searches a record type whose catalogue is on. The same 404 otherwise.',
  'GET /api/public/records/:token': 'The submission a public link opens, when view is on.',
  'PATCH /api/public/records/:token': 'Changes that submission, when edit is on.',
  'DELETE /api/public/records/:token': 'Deletes that submission, when delete is on.',
  'GET /api/connectors/oauth/callback': 'Where a connector’s OAuth provider sends the browser back, carrying the single-use state that names the organisation.',
};

const SAMPLE_ID = '00000000-0000-4000-8000-000000000001';

/** Every method and path the running instance answers, read from Fastify's router. */
async function registeredRoutes(app: FastifyInstance): Promise<Route[]> {
  await app.ready();
  const routes: Route[] = [];
  const labels: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
    if (!line.trim()) continue;
    const indent = /^[│├└─\s]*/u.exec(line)![0].length;
    const node = /^(\S+)(?: \(([A-Z, ]+)\))?$/.exec(line.slice(indent));
    if (!node || indent % 4 !== 0) throw new Error(`Unexpected route listing line: ${line}`);
    labels.length = indent / 4;
    labels[indent / 4 - 1] = node[1]!;
    const path = labels.join('');
    for (const method of node[2]?.split(', ') ?? []) routes.push({ method: method as HTTPMethods, path });
  }
  return routes;
}

const isPublic = (r: Route) => `${r.method === 'HEAD' ? 'GET' : r.method} ${r.path}` in PUBLIC;

/** Routes outside PUBLIC that do not answer an anonymous caller with 401 or 403, with or without a body. */
async function openRoutes(app: FastifyInstance, sample: (path: string) => string): Promise<string[]> {
  const open: string[] = [];
  for (const r of (await registeredRoutes(app)).filter((x) => !isPublic(x))) {
    const withBody = r.method !== 'GET' && r.method !== 'HEAD' && r.method !== 'DELETE';
    for (const payload of withBody ? [undefined, {}] : [undefined]) {
      const res = await app.inject({ method: r.method, url: sample(r.path), ...(payload ? { payload } : {}) });
      if (res.statusCode !== 401 && res.statusCode !== 403) open.push(`${r.method} ${r.path} → ${res.statusCode}`);
    }
  }
  return open;
}

describe('every route refuses a caller who has not signed in, unless it is listed as public', () => {
  let w: TestWorld;
  let app: FastifyInstance;
  const webRoot = mkdtempSync(join(tmpdir(), 'ngo-guard-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>NGO</title>');
  const options = { devAuth: true, schemaDir: SCHEMA_DIR, webRoot, rateLimits: { api: 10_000, auth: 10_000, webhooks: 10_000 } };
  const sample = (path: string) =>
    path
      .replace(/:type\b/g, 'donation')
      .replace(/:kind\b/g, 'recordType')
      .replace(/:provider\b/g, 'razorpay')
      .replace(/:tenantKey\b/g, 'asha')
      .replace(/:(\w+)/g, SAMPLE_ID);

  beforeAll(async () => {
    w = await createWorld();
    await completeIdentity(w, w.ngoA);
    app = buildServer(w.platform, options);
  });
  afterAll(async () => {
    await app.close();
    await w.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('reads every registered route from the router, not from source text', async () => {
    const routes = await registeredRoutes(app);
    expect(routes.length).toBeGreaterThan(150);
    for (const r of routes) expect(app.hasRoute({ method: r.method, url: r.path }), `${r.method} ${r.path}`).toBe(true);
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(keys.size).toBe(routes.length);
    for (const listed of Object.keys(PUBLIC)) expect(keys.has(listed), `${listed} is listed but not registered`).toBe(true);
  });

  it('answers 401 or 403 on every route that is not public, without a body or with one', async () => {
    expect(await openRoutes(app, sample)).toEqual([]);
  });

  it('keeps two-step setup behind sign-in', async () => {
    for (const path of ['/api/auth/two-step/begin', '/api/auth/two-step/confirm']) {
      expect(isPublic({ method: 'POST', path })).toBe(false);
      const res = await app.inject({ method: 'POST', url: path, payload: { code: '123456' } });
      expect(res.statusCode, path).toBe(403);
      expect(res.json()).toMatchObject({ code: 'forbidden', message: 'Sign in first.' });
    }
  });

  it('guards the scheduler tick and payment webhooks by their own secret and signature', async () => {
    for (const method of ['POST', 'GET'] as const) {
      const tick = await app.inject({ method, url: '/internal/tick' });
      expect(tick.statusCode, method).toBe(403);
    }
    expect(app.hasRoute({ method: 'HEAD', url: '/internal/tick' })).toBe(false);
    const hook = await app.inject({ method: 'POST', url: '/webhooks/payments/razorpay/asha', payload: { event: 'payment.captured' } });
    expect(hook.statusCode).toBe(401);
    expect(hook.json()).toEqual({ ok: false });
  });

  it('flags a route added without sign-in that is not on the public list', async () => {
    const drifted = buildServer(w.platform, options);
    try {
      drifted.get('/api/unlisted', async () => ({ ok: true }));
      drifted.post<{ Params: { id: string } }>('/hooks/unlisted/:id', async () => ({ ok: true }));
      expect((await openRoutes(drifted, sample)).sort()).toEqual([
        'GET /api/unlisted → 200',
        'HEAD /api/unlisted → 200',
        'POST /hooks/unlisted/:id → 200',
        'POST /hooks/unlisted/:id → 200',
      ]);
    } finally {
      await drifted.close();
    }
  });

  it('refuses a made-up bearer token and API key the same way', async () => {
    for (const authorization of ['Bearer not-a-token', 'ApiKey ngo_not_a_key']) {
      const res = await app.inject({ method: 'GET', url: '/api/records/donation/query', headers: { authorization } });
      expect([401, 403]).toContain(res.statusCode);
    }
  });

  it('checks sign-in before the body on the definition draft route', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/builder/definitions/recordType/donation/draft', payload: { key: 'other' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden', message: 'Sign in first.' });
  });

  it('resolves the caller once on a signed-in route and never on a public one', async () => {
    const authenticate = vi.spyOn(w.platform.identity, 'authenticate').mockResolvedValue({ tenantId: w.ngoA, actor: clerk });
    try {
      const headers = { authorization: 'Bearer sample-token' };
      expect((await app.inject({ method: 'GET', url: '/health', headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/auth/providers?tenant=asha', headers })).statusCode).toBe(200);
      expect(authenticate).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'GET', url: '/api/approvals/count', headers })).statusCode).toBe(200);
      expect(authenticate).toHaveBeenCalledTimes(1);
      expect(authenticate).toHaveBeenCalledWith('sample-token');
    } finally {
      authenticate.mockRestore();
    }
  });
});
