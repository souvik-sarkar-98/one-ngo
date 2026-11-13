import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { clerk, completeIdentity, createWorld, today, type TestWorld } from '../../../../packages/platform/test/helpers.js';

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await createWorld();
  await completeIdentity(w, w.ngoA);
  app = buildServer(w.platform, { devAuth: true });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

const headers = () => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(clerk) });

describe('HTTP API', () => {
  it('creates, pays, and reads a donation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/records/donation',
      headers: headers(),
      payload: { donorName: 'Web donor', amount: 750 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().record.id as string;

    const paid = await app.inject({
      method: 'POST',
      url: `/api/records/donation/${id}/transitions/markPaid`,
      headers: headers(),
      payload: { expectedVersion: 1, data: { method: 'cash', paidOn: today() } },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().receipts).toHaveLength(1);

    const read = await app.inject({ method: 'GET', url: `/api/records/donation/${id}`, headers: headers() });
    expect(read.json()).toMatchObject({ status: 'paid', version: 2 });
  });

  it('maps platform errors to status codes without leaking internals', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/records/donation',
      headers: headers(),
      payload: { amount: 10 },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: 'validation_failed' });

    const unsigned = await app.inject({ method: 'GET', url: '/api/records/donation' });
    expect(unsigned.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/records/donation/00000000-0000-0000-0000-000000000000',
      headers: headers(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('signs in with a password, uses the bearer token, and refreshes through the HttpOnly cookie', async () => {
    const id = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'web@example.org', displayName: 'Web', roles: ['finance'] });
    await w.platform.identity.setPassword(id, 'web user password');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { tenant: 'asha', email: 'web@example.org', password: 'web user password' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/^ngo_rt=[^;]+; HttpOnly; SameSite=Strict; Path=\/api\/auth/);
    const { accessToken } = login.json() as { accessToken: string };
    expect(login.json()).not.toHaveProperty('refreshToken');

    const list = await app.inject({ method: 'GET', url: '/api/records/donation', headers: { authorization: `Bearer ${accessToken}` } });
    expect(list.statusCode).toBe(200);

    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie.split(';')[0]! } });
    expect(refreshed.statusCode).toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: cookie.split(';')[0]! } });
    expect(replay.statusCode).toBe(403);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { tenant: 'asha', email: 'web@example.org', password: 'wrong password' },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().message).toMatch(/Sign-in failed/);
  });

  it('allows only listed browser origins, and marks that refresh cookie cross-site', async () => {
    const open = buildServer(w.platform, { corsOrigins: ['http://localhost:4200'] });
    const origin = 'http://localhost:4200';
    const preflight = await open.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(preflight.headers['access-control-allow-headers']).toContain('content-type');
    expect(preflight.headers['access-control-allow-headers']).toContain('authorization');
    expect(preflight.headers.vary).toBe('origin');

    const foreign = await open.inject({ method: 'GET', url: '/health', headers: { origin: 'http://evil.example' } });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    const id = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'cors@example.org', displayName: 'Cors', roles: ['finance'] });
    await w.platform.identity.setPassword(id, 'cors user password');
    const login = await open.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { tenant: 'asha', email: 'cors@example.org', password: 'cors user password' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['access-control-allow-origin']).toBe(origin);
    expect(String(login.headers['set-cookie'])).toMatch(/SameSite=None/);
    expect(String(login.headers['set-cookie'])).toMatch(/Secure/);

    const sameSite = await open.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { tenant: 'asha', email: 'cors@example.org', password: 'cors user password' },
    });
    expect(String(sameSite.headers['set-cookie'])).toMatch(/SameSite=Strict/);
    expect(String(sameSite.headers['set-cookie'])).not.toMatch(/SameSite=None/);
    expect(String(sameSite.headers['set-cookie'])).toMatch(/; Secure$/);
    await open.close();
  });

  it('sends no CORS headers when no origins are configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:4200' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/login',
      headers: { origin: 'http://localhost:4200', 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(404);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('protects the scheduler tick', async () => {
    const secured = buildServer(w.platform, { tickSecret: 'tick-secret-value' });
    expect((await secured.inject({ method: 'POST', url: '/internal/tick' })).statusCode).toBe(403);
    expect(
      (await secured.inject({ method: 'POST', url: '/internal/tick', headers: { 'x-appengine-cron': 'true' } })).statusCode,
    ).toBe(403);
    const ok = await secured.inject({ method: 'POST', url: '/internal/tick', headers: { authorization: 'Bearer tick-secret-value' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveProperty('dispatch');
    await secured.close();
  });

  it('refuses header sign-in outside a test run', () => {
    const previous = process.env.NODE_ENV;
    try {
      for (const env of ['production', 'development']) {
        process.env.NODE_ENV = env;
        expect(() => buildServer(w.platform, { devAuth: true })).toThrow(/outside a test run/);
      }
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
