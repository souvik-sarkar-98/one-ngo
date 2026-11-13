import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { ConnectorRequest, ConnectorResponse } from '../src/infrastructure/connectors/http.js';
import { admin, createWorld, type TestWorld } from './helpers.js';

const OAUTH_ACCESS = 'ya29.access-token-never-in-a-response';
const OAUTH_REFRESH = '1//refresh-token-never-in-a-response';
const OAUTH_CLIENT = 'client-secret-never-in-a-response';
/** Only the oauth token endpoint answers; it grants OAUTH_ACCESS and OAUTH_REFRESH. */
const tokenEndpoint = async (req: ConnectorRequest): Promise<ConnectorResponse> => {
  if (req.url !== 'https://id.test/token') throw new Error(`Tests never call out: ${req.method} ${req.url}`);
  return { status: 200, body: JSON.stringify({ access_token: OAUTH_ACCESS, refresh_token: OAUTH_REFRESH, expires_in: 30 }) };
};

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false, connectorHttp: tokenEndpoint });
  app = buildServer(w.platform, { devAuth: true, rateLimits: { auth: 1000 } });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

const headers = () => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(admin) });
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: headers(), ...(payload ? { payload } : {}) });

/** Every administration answer that could echo a key or a connector back. */
const VIEWS = ['/api/admin/api-keys', '/api/admin/connectors', '/api/admin/audit?limit=200', '/api/admin/settings', '/api/openapi.json'];

describe('API-key token', () => {
  it('appears only in the create answer', async () => {
    const created = await call('POST', '/api/admin/api-keys', { name: 'Shown once', role: 'finance' });
    expect(created.statusCode).toBe(201);
    const { id, token } = created.json() as { id: string; token: string };
    const secret = token.split('.')[1]!;
    expect(token).toBe(`${id}.${secret}`);

    for (const url of VIEWS) {
      const res = await call('GET', url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toContain(secret);
    }
    const listed = (await call('GET', '/api/admin/api-keys')).json() as Record<string, unknown>[];
    expect(listed.find((k) => k.id === id)).not.toHaveProperty('token');
    expect((await call('DELETE', `/api/admin/api-keys/${id}`)).body).toBe('');
  });

  it('is dropped from the list even if the service were to return it', async () => {
    const real = await w.platform.apiKeys.list(w.as(w.ngoA));
    const spy = vi.spyOn(w.platform.apiKeys, 'list').mockResolvedValueOnce(real.map((k) => ({ ...k, token: `${k.id}.leaked-secret` })));
    const res = await call('GET', '/api/admin/api-keys');
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('leaked-secret');
  });
});

describe('connector secrets', () => {
  const SIGNING = 'whsec-never-in-a-response-0123456789';
  const GATEWAY = 'rzp-key-secret-never-in-a-response';

  beforeAll(async () => {
    const saved = await call('PUT', '/api/admin/connectors/notify', {
      kind: 'webhook',
      enabled: true,
      config: { url: 'https://hooks.test/in' },
      secrets: { signingSecret: SIGNING },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ key: 'notify', secrets: ['signingSecret'], configured: true });
    expect(saved.body).not.toContain(SIGNING);
    await w.platform.payments.saveGatewayCredentials(w.as(w.ngoA), 'razorpay', { keyId: 'rzp_public', keySecret: GATEWAY, webhookSecret: 'whsec-gateway' });
  });

  it('never appear in a connector view, the list, deliveries or the audit log', async () => {
    for (const url of [...VIEWS, '/api/admin/connectors/notify', '/api/admin/connectors/notify/deliveries', '/api/admin/connectors/razorpay']) {
      const res = await call('GET', url);
      for (const secret of [SIGNING, GATEWAY, 'whsec-gateway']) expect(res.body, url).not.toContain(secret);
    }
  });

  it('are dropped from the connector view even if the service were to return them', async () => {
    const view = await w.platform.connectors.get(w.as(w.ngoA), 'notify');
    const spy = vi.spyOn(w.platform.connectors, 'get').mockResolvedValueOnce({ ...view, secretValues: { signingSecret: SIGNING } } as typeof view);
    const res = await call('GET', '/api/admin/connectors/notify');
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    expect(res.body).not.toContain(SIGNING);
  });
});

describe('oauth connector tokens', () => {
  it('never appear in the connect redirect, a connector view, the list, deliveries, the audit log or the stored row', async () => {
    const saved = await call('PUT', '/api/admin/connectors/google', {
      kind: 'oauth',
      enabled: true,
      config: { authorizationUrl: 'https://id.test/authorize', tokenUrl: 'https://id.test/token', clientId: 'client-1', scopes: ['mail.send'] },
      secrets: { clientSecret: OAUTH_CLIENT },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const start = await call('POST', '/api/admin/connectors/google/oauth/start');
    expect(start.statusCode, start.body).toBe(200);
    const state = new URL((start.json() as { url: string }).url).searchParams.get('state')!;
    const back = await app.inject({ method: 'GET', url: `/api/connectors/oauth/callback?code=c-1&state=${encodeURIComponent(state)}` });
    expect(back.headers.location).toBe('/admin/connectors/google?connected=1');
    const tested = await call('POST', '/api/admin/connectors/google/test', {});
    expect(tested.json()).toMatchObject({ ok: true });

    const answers = [start.body, back.body, JSON.stringify(back.headers), tested.body];
    for (const url of [...VIEWS, '/api/admin/connectors/google', '/api/admin/connectors/google/deliveries']) {
      const res = await call('GET', url);
      expect(res.statusCode, url).toBe(200);
      answers.push(res.body);
    }
    expect((await call('GET', '/api/admin/connectors/google')).json()).toMatchObject({ secrets: ['accessToken', 'accessTokenExpiresAt', 'clientSecret', 'refreshToken'] });
    const [row] = await w.platform.db.asSystem((tx) => tx.query<{ secret_enc: string }>(`select secret_enc from connector where tenant_id = $1 and key = 'google'`, [w.ngoA]));
    answers.push(row!.secret_enc);
    for (const body of answers) for (const secret of [OAUTH_ACCESS, OAUTH_REFRESH, OAUTH_CLIENT]) expect(body).not.toContain(secret);
  });
});

describe('refresh token', () => {
  it('travels only in the HttpOnly cookie, on sign-in and on refresh', async () => {
    const userId = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'cookie@asha.org', displayName: 'Cookie', roles: [] });
    await w.platform.identity.setPassword(userId, 'a long enough password');

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { tenant: 'asha', email: 'cookie@asha.org', password: 'a long enough password' } });
    expect(login.statusCode, login.body).toBe(200);
    expect(Object.keys(login.json()).sort()).toEqual(['accessToken', 'expiresIn']);
    const cookie = /^ngo_rt=([^;]+)/.exec(String(login.headers['set-cookie']))![1]!;
    const refreshToken = decodeURIComponent(cookie);
    expect(login.body).not.toContain(refreshToken);

    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `ngo_rt=${cookie}` } });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(Object.keys(refreshed.json()).sort()).toEqual(['accessToken', 'expiresIn']);
    const next = decodeURIComponent(/^ngo_rt=([^;]+)/.exec(String(refreshed.headers['set-cookie']))![1]!);
    expect(next).not.toBe(refreshToken);
    expect(refreshed.body).not.toContain(refreshToken);
    expect(refreshed.body).not.toContain(next);

    const me = await app.inject({ method: 'GET', url: '/api/people/me', headers: { authorization: `Bearer ${refreshed.json().accessToken}` } });
    expect(me.statusCode).toBe(200);
    for (const token of [refreshToken, next]) expect(me.body).not.toContain(token);
  });
});
