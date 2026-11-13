import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OidcService, type HttpFetch } from '../../../../packages/platform/src/application/identity/oidc.js';
import { demoSubject, GOOGLE, OPERATOR } from '../src/constants.js';
import type { Fixture } from '../src/server.js';
import { call, tempFixture } from './helpers.js';

const REDIRECT = 'http://localhost:8080/api/auth/oidc/callback';
const form = (values: Record<string, string>) => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });

let fixture: Fixture;
let cleanup: () => Promise<void>;
beforeAll(async () => ({ fixture, cleanup } = await tempFixture()));
afterAll(() => cleanup());

async function signIn(email: string, nonce: string, verifier: string, challenge = createHash('sha256').update(verifier).digest('base64url'), clientId: string = GOOGLE.clientId) {
  const params = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid email profile', state: 'st4te', nonce, code_challenge: challenge, code_challenge_method: 'S256' };
  const page = await call(fixture, `/oauth2/authorize?${new URLSearchParams(params)}`);
  expect(page.status).toBe(200);
  expect(page.text).toContain('name="email"');
  const back = await call(fixture, '/oauth2/authorize', { method: 'POST', ...form({ ...params, email, decision: 'allow' }) });
  expect(back.status).toBe(302);
  const location = new URL(String(back.headers.location));
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get('state')).toBe('st4te');
  return location.searchParams.get('code')!;
}

describe('OpenID Connect stand-in', () => {
  it('publishes https endpoints under its own origin', async () => {
    const doc = (await call(fixture, '/.well-known/openid-configuration')).json<Record<string, string>>();
    expect(doc).toMatchObject({ issuer: fixture.origin, authorization_endpoint: `${fixture.origin}/oauth2/authorize`, token_endpoint: `${fixture.origin}/oauth2/token`, jwks_uri: `${fixture.origin}/oauth2/jwks` });
  });

  it('issues an ID token for the entered email that verifies against its JWKS', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await signIn('Member@Asha.org', 'n0nce', verifier);
    const token = await call(fixture, '/oauth2/token', {
      method: 'POST',
      ...form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret, code_verifier: verifier }),
    });
    expect(token.status).toBe(200);
    const idToken = token.json<{ id_token: string }>().id_token;
    const jwks = (await call(fixture, '/oauth2/jwks')).json<JSONWebKeySet>();
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), { issuer: fixture.origin, audience: GOOGLE.clientId, algorithms: ['RS256'] });
    expect(payload).toMatchObject({ email: 'member@asha.org', email_verified: true, nonce: 'n0nce', sub: demoSubject('member@asha.org') });
    expect(payload.amr).toBeUndefined();

    const reused = await call(fixture, '/oauth2/token', {
      method: 'POST',
      ...form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret, code_verifier: verifier }),
    });
    expect(reused.json()).toEqual({ error: 'invalid_grant' });
  });

  it('passes the checks one-ngo makes on an ID token', async () => {
    const http: HttpFetch = async (url, init) => {
      const res = await call(fixture, url, { method: init?.method ?? 'GET', ...(init?.headers ? { headers: init.headers } : {}), ...(init?.body ? { body: init.body } : {}) });
      return { status: res.status, json: async () => res.json() };
    };
    const service = new OidcService({} as never, {} as never, {} as never, {} as never, {} as never, { publicBaseUrl: 'http://localhost:8080', crypto: {} as never, fetch: http });
    const doc = (await call(fixture, '/.well-known/openid-configuration')).json<{ issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }>();
    const cfg = { id: 'google', label: 'Google', issuer: fixture.origin, clientId: GOOGLE.clientId, clientSecret: GOOGLE.clientSecret };
    const idToken = await fixture.oidc.idToken({ email: 'member@asha.org', nonce: 'n1' });
    await expect(service.verifyIdToken(idToken, cfg, doc, 'n1')).resolves.toMatchObject({ email: 'member@asha.org', iss: fixture.origin });
    await expect(service.verifyIdToken(idToken, cfg, doc, 'another-nonce')).rejects.toThrow();
  });

  it('issues operator ID tokens that report multi-factor sign-in, only to the operator client', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = await signIn('operator.full@onengo.local', 'n4', verifier, challenge, OPERATOR.clientId);
    const asGoogle = await call(fixture, '/oauth2/token', {
      method: 'POST',
      ...form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret, code_verifier: verifier }),
    });
    expect(asGoogle.json()).toEqual({ error: 'invalid_grant' });

    const code2 = await signIn('operator.full@onengo.local', 'n5', verifier, challenge, OPERATOR.clientId);
    const token = await call(fixture, '/oauth2/token', {
      method: 'POST',
      ...form({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: OPERATOR.clientId, client_secret: OPERATOR.clientSecret, code_verifier: verifier }),
    });
    expect(token.status).toBe(200);
    const jwks = (await call(fixture, '/oauth2/jwks')).json<JSONWebKeySet>();
    const { payload } = await jwtVerify(token.json<{ id_token: string }>().id_token, createLocalJWKSet(jwks), { issuer: fixture.origin, audience: OPERATOR.clientId, algorithms: ['RS256'] });
    expect(payload).toMatchObject({ amr: ['pwd', 'mfa'], azp: OPERATOR.clientId, nonce: 'n5', sub: demoSubject('operator.full@onengo.local') });
    expect(Math.abs(Number(payload.auth_time) - Date.now() / 1000)).toBeLessThan(60);
  });

  it('refuses a wrong client secret and a verifier that does not match', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await signIn('member@asha.org', 'n2', verifier);
    const wrongSecret = await call(fixture, '/oauth2/token', {
      method: 'POST',
      ...form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: GOOGLE.clientId, client_secret: 'nope', code_verifier: verifier }),
    });
    expect(wrongSecret.status).toBe(401);
    const code2 = await signIn('member@asha.org', 'n3', verifier);
    const wrongVerifier = await call(fixture, '/oauth2/token', {
      method: 'POST',
      ...form({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: GOOGLE.clientId, client_secret: GOOGLE.clientSecret, code_verifier: 'x'.repeat(43) }),
    });
    expect(wrongVerifier.status).toBe(400);
  });
});
