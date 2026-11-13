import { createSign, generateKeyPairSync, sign as signRaw } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { totpCode, type HttpFetch, type OidcProviderConfig } from '@onengo/platform/testing';
import { admin, createWorld, expectCode, type TestWorld } from '../../../../packages/platform/test/helpers.js';

// ---------------------------------------------------------- fake provider

const ISSUER = 'https://login.example-idp.test';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = {
  keys: [
    { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa1', alg: 'RS256', use: 'sig' },
    { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec1', alg: 'ES256', use: 'sig' },
  ],
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims: Record<string, unknown>, opts: { alg?: 'RS256' | 'ES256'; kid?: string; key?: typeof rsa.privateKey } = {}) {
  const alg = opts.alg ?? 'RS256';
  const head = b64({ alg, kid: opts.kid ?? (alg === 'RS256' ? 'rsa1' : 'ec1'), typ: 'JWT' });
  const body = b64(claims);
  const data = `${head}.${body}`;
  const sig =
    alg === 'RS256'
      ? createSign('RSA-SHA256').update(data).sign(opts.key ?? rsa.privateKey).toString('base64url')
      : signRaw('sha256', Buffer.from(data), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${data}.${sig}`;
}

/** What the next token exchange should return; set per test. */
let nextIdToken: (nonce: string) => string = () => '';
let lastNonce = '';
const tokenRequests: URLSearchParams[] = [];
let jwksRequests = 0;
let jwksDown = false;

const fakeFetch: HttpFetch = async (url, init) => {
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return {
      status: 200,
      json: async () => ({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      }),
    };
  }
  if (url === `${ISSUER}/jwks`) {
    jwksRequests++;
    return jwksDown ? { status: 503, json: async () => ({}) } : { status: 200, json: async () => jwks };
  }
  if (url === `${ISSUER}/token`) {
    tokenRequests.push(new URLSearchParams(init?.body ?? ''));
    return { status: 200, json: async () => ({ id_token: nextIdToken(lastNonce) }) };
  }
  return { status: 404, json: async () => ({}) };
};

const provider: OidcProviderConfig = { id: 'idp', label: 'Example IdP', issuer: ISSUER, clientId: 'client-123', clientSecret: 'shh' };

const claimsFor = (email: string, nonce: string, extra: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, aud: 'client-123', sub: `sub-${email}`, email, email_verified: true, nonce, iat: now, exp: now + 300, ...extra };
};

// ------------------------------------------------------------------ tests

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
let meera: string;

beforeAll(async () => {
  w = await createWorld({ oidcProviders: [provider], oidcFetch: fakeFetch });
  await w.platform.oidc.saveProviderPolicy(w.as(w.ngoA), 'idp', { enabled: true, assurance: 'aal1' });
  await w.platform.oidc.saveProviderPolicy(w.as(w.ngoB), 'idp', { enabled: true, assurance: 'aal1' });
  app = buildServer(w.platform, { devAuth: true, rateLimits: { auth: 1000 } });
  meera = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'meera@asha.org', displayName: 'Meera', roles: ['finance'] });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

async function startLogin(next = '/records/donation'): Promise<{ state: string; nonce: string; location: string }> {
  const res = await app.inject({ method: 'GET', url: `/api/auth/oidc/idp/start?tenant=asha&next=${encodeURIComponent(next)}` });
  expect(res.statusCode).toBe(302);
  const location = String(res.headers.location);
  const u = new URL(location);
  lastNonce = u.searchParams.get('nonce')!;
  return { state: u.searchParams.get('state')!, nonce: lastNonce, location };
}

const callback = (state: string, code = 'auth-code') =>
  app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=${code}&state=${encodeURIComponent(state)}` });

describe('password reset and invitations', () => {
  it('emails a single-use reset link, sets the password, and ends existing sessions', async () => {
    await w.platform.identity.setPassword(meera, 'original password!');
    const session = await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'meera@asha.org', password: 'original password!' });

    w.mail.sent.length = 0;
    await w.platform.identity.requestPasswordReset({ tenantKey: 'asha', email: 'nobody@asha.org' });
    expect(w.mail.sent).toHaveLength(0);
    await w.platform.identity.requestPasswordReset({ tenantKey: 'asha', email: 'MEERA@asha.org' });
    expect(w.mail.sent).toHaveLength(1);
    const link = new URL(/(https:\/\/ngo\.test\S+)/.exec(w.mail.sent[0]!.text)![1]!);
    expect(link.pathname).toBe('/reset-password');
    expect(link.searchParams.get('org')).toBe('asha');
    const token = link.searchParams.get('token')!;

    await expectCode(w.platform.identity.completePasswordToken({ token, password: 'short' }), 'validation_failed');
    expect(await w.platform.identity.completePasswordToken({ token, password: 'a brand new password' })).toEqual({ tenantKey: 'asha' });
    await expectCode(w.platform.identity.completePasswordToken({ token, password: 'another new password' }), 'forbidden');
    await expectCode(w.platform.identity.refresh(session.refreshToken), 'forbidden');
    await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'meera@asha.org', password: 'a brand new password' });
  });

  it('makes earlier links stop working when a new one is sent', async () => {
    w.mail.sent.length = 0;
    await w.platform.identity.inviteMember(w.as(w.ngoA), meera);
    await w.platform.identity.inviteMember(w.as(w.ngoA), meera);
    const tokens = w.mail.sent.map((m) => new URL(/(https:\/\/ngo\.test\S+)/.exec(m.text)![1]!).searchParams.get('token')!);
    expect(w.mail.sent[0]!.subject).toBe('You have been invited to Asha Trust');
    await expectCode(w.platform.identity.completePasswordToken({ token: tokens[0]!, password: 'invite password 1' }), 'forbidden');
    await w.platform.identity.completePasswordToken({ token: tokens[1]!, password: 'invite password 2' });
  });

  it('requires permission to invite, and limits reset emails', async () => {
    const clerkCtx = await w.platform.identity.authenticate(
      (await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'meera@asha.org', password: 'invite password 2' })).accessToken,
    );
    await expectCode(w.platform.identity.inviteMember(clerkCtx, meera), 'forbidden');
    w.mail.sent.length = 0;
    for (let i = 0; i < 5; i++) await w.platform.identity.requestPasswordReset({ tenantKey: 'asha', email: 'limit-check@asha.org' });
    const other = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'limited@asha.org', displayName: 'L', roles: [] });
    expect(other).toBeTruthy();
    for (let i = 0; i < 5; i++) await w.platform.identity.requestPasswordReset({ tenantKey: 'asha', email: 'limited@asha.org' });
    expect(w.mail.sent).toHaveLength(3);
  });

  it('DEF-33: says whether a link still works before a password is typed, without using it up', async () => {
    const invited = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'expiry-check@asha.org', displayName: 'Expiry Check', roles: [] });
    w.mail.sent.length = 0;
    await w.platform.identity.inviteMember(w.as(w.ngoA), invited);
    const token = new URL(/(https:\/\/ngo\.test\S+)/.exec(w.mail.sent[0]!.text)![1]!).searchParams.get('token')!;
    const check = (body: { token: string }) => app.inject({ method: 'POST', url: '/api/auth/password-reset/check', payload: body });

    expect((await check({ token })).json()).toEqual({ usable: true });
    expect((await check({ token })).json()).toEqual({ usable: true });
    expect((await check({ token: 'never-issued' })).json()).toEqual({ usable: false });

    await w.platform.identity.completePasswordToken({ token, password: 'a password after the check' });
    expect((await check({ token })).json()).toEqual({ usable: false });
  });
});

describe('sign-in with an OpenID Connect provider', () => {
  it('lists providers for an organisation without revealing secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/providers?tenant=asha' });
    expect(res.json()).toEqual([{ id: 'idp', label: 'Example IdP' }]);
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers?tenant=nope' })).json()).toEqual([]);
  });

  it('runs the code flow with PKCE, signs in an existing member, and sets only the refresh cookie', async () => {
    const { state, location } = await startLogin();
    const auth = new URL(location);
    expect(auth.origin + auth.pathname).toBe(`${ISSUER}/authorize`);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('redirect_uri')).toBe('https://ngo.test/api/auth/oidc/callback');

    nextIdToken = (nonce) => idToken(claimsFor('meera@asha.org', nonce));
    const res = await callback(state);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/records/donation');
    expect(String(res.headers['set-cookie'])).toMatch(/^ngo_rt=.+; HttpOnly; SameSite=Strict; Path=\/api\/auth; Max-Age=\d+; Secure/);
    expect(String(res.headers.location)).not.toContain('token');

    const sent = tokenRequests.at(-1)!;
    expect(sent.get('code_verifier')).toHaveLength(64);
    expect(sent.get('client_secret')).toBe('shh');

    await expect(callback(state).then((r) => r.headers.location)).resolves.toBe('/sign-in?reason=unfinished');
  });

  it('accepts ES256 tokens and links by provider subject after the first sign-in', async () => {
    const { state } = await startLogin('/');
    nextIdToken = (nonce) => idToken(claimsFor('meera@asha.org', nonce, { email: 'Meera@ASHA.org' }), { alg: 'ES256' });
    expect((await callback(state)).headers.location).toBe('/');
    const links = await w.platform.db.asSystem((tx) => tx.query(`select 1 from user_identity where user_id = $1`, [meera]));
    expect(links).toHaveLength(1);
  });

  it('does not link an identity when the provider is below NGO assurance policy', async () => {
    const userId = await w.platform.identity.addMember(w.as(w.ngoA), {
      email: 'no-link@asha.org',
      displayName: 'No link',
      roles: [],
    });
    await w.platform.identity.saveAuthPolicy(w.as(w.ngoA), {
      passwordEnabled: true,
      emailCodeEnabled: true,
      passkeyEnabled: false,
      minimumAssurance: 'aal2',
    });
    try {
      const { state } = await startLogin('/');
      nextIdToken = (nonce) => idToken(claimsFor('no-link@asha.org', nonce));
      const location = new URL(String((await callback(state)).headers.location), 'https://ngo.test');
      expect(location.searchParams.get('reason')).toBe('notAllowed');
      const links = await w.platform.db.asSystem((tx) => tx.query(`select 1 from user_identity where user_id = $1`, [userId]));
      expect(links).toHaveLength(0);
    } finally {
      await w.platform.identity.saveAuthPolicy(w.as(w.ngoA), {
        passwordEnabled: true,
        emailCodeEnabled: true,
        passkeyEnabled: false,
        minimumAssurance: 'aal1',
      });
    }
  });

  const rejects: [string, (nonce: string) => string, string][] = [
    ['a wrong nonce', () => idToken(claimsFor('meera@asha.org', 'other-nonce')), 'failed'],
    ['a token for another app', (n) => idToken(claimsFor('meera@asha.org', n, { aud: 'someone-else' })), 'failed'],
    ['a token from another issuer', (n) => idToken(claimsFor('meera@asha.org', n, { iss: 'https://evil.test' })), 'failed'],
    ['an expired token', (n) => idToken(claimsFor('meera@asha.org', n, { exp: Math.floor(Date.now() / 1000) - 600 })), 'failed'],
    ['a forged signature', (n) => idToken(claimsFor('meera@asha.org', n), { key: rogue.privateKey }), 'failed'],
    ['an unknown key id', (n) => idToken(claimsFor('meera@asha.org', n), { kid: 'missing' }), 'failed'],
    ['an unverified email', (n) => idToken(claimsFor('meera@asha.org', n, { email_verified: false })), 'emailUnverified'],
    ['someone who is not a member', (n) => idToken(claimsFor('stranger@asha.org', n)), 'notMember'],
    ['an unsigned token', (n) => `${b64({ alg: 'none' })}.${b64(claimsFor('meera@asha.org', n))}.`, 'failed'],
  ];
  for (const [label, token, reason] of rejects) {
    it(`rejects ${label}`, async () => {
      const { state } = await startLogin();
      nextIdToken = token;
      const res = await callback(state);
      expect(res.statusCode).toBe(302);
      expect(res.headers['set-cookie']).toBeUndefined();
      const location = new URL(String(res.headers.location), 'https://ngo.test');
      expect(location.pathname).toBe('/sign-in');
      // Only a key the sign-in page knows: the page never shows text from the address (DEF-30).
      expect([...location.searchParams.keys()]).toEqual(['reason']);
      expect(location.searchParams.get('reason')).toBe(reason);
    });
  }

  it('caches the provider keys, fetches them again only for an unknown key id, and refuses tokens without a key id', async () => {
    const signIn = async (token: (nonce: string) => string) => {
      const { state } = await startLogin('/');
      nextIdToken = token;
      return new URL(String((await callback(state)).headers.location), 'https://ngo.test');
    };
    const before = jwksRequests;
    expect((await signIn((n) => idToken(claimsFor('meera@asha.org', n)))).pathname).toBe('/');
    expect(jwksRequests).toBe(before);
    expect((await signIn((n) => idToken(claimsFor('meera@asha.org', n), { kid: 'rotated' }))).searchParams.get('reason')).toBe('failed');
    expect(jwksRequests).toBe(before + 1);

    const noKid = (n: string) => {
      const data = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claimsFor('meera@asha.org', n))}`;
      return `${data}.${createSign('RSA-SHA256').update(data).sign(rsa.privateKey).toString('base64url')}`;
    };
    expect((await signIn(noKid)).searchParams.get('reason')).toBe('failed');

    jwksDown = true;
    try {
      const reason = (await signIn((n) => idToken(claimsFor('meera@asha.org', n), { kid: 'rotated-again' }))).searchParams.get('reason');
      expect(reason).toBe('unreachable');
    } finally {
      jwksDown = false;
    }
  });

  it('refuses unknown or expired states and open redirects', async () => {
    expect((await callback('made-up-state')).headers.location).toBe('/sign-in?reason=unfinished');
    const { state } = await startLogin('//evil.example/steal');
    nextIdToken = (n) => idToken(claimsFor('meera@asha.org', n, { sub: 'sub-meera@asha.org' }));
    expect((await callback(state)).headers.location).toBe('/');
  });

  it('still asks for the authenticator code when the role requires two-step', async () => {
    await w.platform.identity.upsertRole(w.as(w.ngoA), { key: 'cashier', label: 'Cashier', permissions: ['*'], requireTwoStep: true });
    const ravi = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'ravi@asha.org', displayName: 'Ravi', roles: [] });
    await w.platform.identity.setPassword(ravi, 'monsoon in the hills');
    const ctx = await w.platform.identity.authenticate(
      (await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'ravi@asha.org', password: 'monsoon in the hills' })).accessToken,
    );
    const { secret } = await w.platform.identity.beginTwoStep(ctx);
    await w.platform.identity.confirmTwoStep(ctx, totpCode(secret));
    await w.platform.people.addRoleMembers(w.as(w.ngoA, admin), 'cashier', { userIds: [ravi] });

    const { state } = await startLogin('/inbox');
    nextIdToken = (n) => idToken(claimsFor('ravi@asha.org', n));
    const res = await callback(state);
    expect(res.headers['set-cookie']).toBeUndefined();
    const location = new URL(String(res.headers.location), 'https://ngo.test');
    expect(location.pathname).toBe('/sign-in');
    const ticket = location.searchParams.get('ticket')!;
    expect(location.searchParams.get('next')).toBe('/inbox');

    const wrong = await app.inject({ method: 'POST', url: '/api/auth/two-step/complete', payload: { ticket, totpCode: '000000' } });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/two-step/complete', payload: { ticket, totpCode: totpCode(secret) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accessToken).toBeTruthy();
    const replay = await app.inject({ method: 'POST', url: '/api/auth/two-step/complete', payload: { ticket, totpCode: totpCode(secret) } });
    expect(replay.statusCode).toBe(403);
  });

  it('requires NGO-run providers to be limited to the NGO’s own email domains', async () => {
    await expectCode(
      w.platform.oidc.saveTenantProvider(w.as(w.ngoB), { id: 'own', label: 'Our login', issuer: ISSUER, clientId: 'c', clientSecret: 's' }),
      'validation_failed',
    );
    await w.platform.oidc.saveTenantProvider(w.as(w.ngoB), {
      id: 'own',
      label: 'Our login',
      issuer: ISSUER,
      clientId: 'client-123',
      clientSecret: 's',
      allowedDomains: ['bodhi.org'],
    });
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers?tenant=bodhi' })).json()).toEqual([
      { id: 'own', label: 'Our login' },
      { id: 'idp', label: 'Example IdP' },
    ]);
  });
});
