import { createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { operatorControlPlane, type OperatorControlPlane } from '../src/application/organisations/control-plane.js';
import { verifiedOperatorPrincipal, type OperatorPrincipal } from '../src/application/organisations/operator-principal.js';
import type { ConnectorHttp } from '../src/application/connectors/ports/connector-runtime.js';
import type { HttpFetch } from '../src/application/identity/oidc.js';
import { organisationOperations } from '../src/composition/organisations.js';
import { PATHS } from '../src/platform.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

// A shared provider every organisation may opt into, and one Asha runs itself.
const SHARED = 'https://shared-idp.test';
const OWN = 'https://login.asha-idp.test';
const SECRET = 'asha-client-secret-value';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] };
const discovery = (issuer: string) => ({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(issuer: string, aud: string, email: string, nonce: string): string {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64({ iss: issuer, aud, sub: `sub-${email}`, email, email_verified: true, nonce, iat: now, exp: now + 300 })}`;
  return `${data}.${createSign('RSA-SHA256').update(data).sign(rsa.privateKey).toString('base64url')}`;
}

let nextToken: (nonce: string) => string = () => '';
let lastNonce = '';
const tokenSecrets: string[] = [];
const oidcFetch: HttpFetch = async (url, init) => {
  for (const issuer of [SHARED, OWN]) {
    if (url === `${issuer}/.well-known/openid-configuration`) return { status: 200, json: async () => discovery(issuer) };
    if (url === `${issuer}/jwks`) return { status: 200, json: async () => jwks };
    if (url === `${issuer}/token`) {
      tokenSecrets.push(new URLSearchParams(init?.body ?? '').get('client_secret') ?? '');
      return { status: 200, json: async () => ({ id_token: nextToken(lastNonce) }) };
    }
  }
  return { status: 404, json: async () => ({}) };
};

/** The connection test's outbound HTTP: Asha's provider answers; anything else is unreachable. */
const connectorHttp: ConnectorHttp = async (req) => {
  if (req.url === `${OWN}/.well-known/openid-configuration`) return { status: 200, body: JSON.stringify(discovery(OWN)) };
  if (req.url === `${OWN}/jwks`) return { status: 200, body: JSON.stringify(jwks) };
  if (req.url === `${SHARED}/.well-known/openid-configuration`) return { status: 200, body: JSON.stringify({ ...discovery(SHARED), issuer: 'https://elsewhere.test' }) };
  throw new Error('Not sent: the connector address is not a public internet address.');
};

let w: TestWorld;
let app: ReturnType<typeof buildServer>;
let control: OperatorControlPlane;
let principal: OperatorPrincipal;
let sessionId: string;

/** A fresh one-use step-up for `sign_in` on the organisation, as the console records it. */
async function stepUp(target = 'asha'): Promise<string> {
  const id = randomUUID();
  await w.platform.db.asSystem((tx) =>
    tx.query(
      `insert into operator_step_up (id, session_id, action, target, nonce_hash, auth_time, amr, expires_at)
       values ($1, $2, 'sign_in', $3, $4, now(), '{mfa}', now() + interval '5 minutes')`,
      [id, sessionId, target, randomBytes(32).toString('hex')],
    ),
  );
  return id;
}

async function startLogin(provider: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: `/api/auth/oidc/${provider}/start?tenant=asha&next=%2F` });
  expect(res.statusCode, res.body).toBe(302);
  const location = new URL(String(res.headers.location));
  lastNonce = location.searchParams.get('nonce')!;
  return location.searchParams.get('state')!;
}
const callback = (state: string) => app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(state)}` });

beforeAll(async () => {
  w = await createWorld({
    oidcProviders: [{ id: 'google', label: 'Google', issuer: SHARED, clientId: 'shared-client', clientSecret: 'shared-secret' }],
    oidcFetch,
    connectorHttp,
  });
  app = buildServer(w.platform, { devAuth: true, rateLimits: { auth: 1000 } });
  control = operatorControlPlane(organisationOperations(w.platform, PATHS, { http: connectorHttp }));
  const operatorId = randomUUID();
  sessionId = randomUUID();
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into operator_account (id, display_name) values ($1, 'Operations User')`, [operatorId]);
    await tx.query(
      `insert into operator_session (id, token_hash, operator_id, issuer, subject, display_snapshot, auth_time, amr, expires_at)
       values ($1, $2, $3, 'https://operators.test/', 'ops-1', 'Operations User', now(), '{mfa}', now() + interval '1 hour')`,
      [sessionId, randomBytes(32).toString('hex'), operatorId],
    );
  });
  principal = verifiedOperatorPrincipal({
    operatorId, issuer: 'https://operators.test/', subject: 'ops-1', display: 'Operations User',
    authTime: new Date(), amr: ['mfa'], assurance: 'mfa', sessionId, actions: ['sign_in'],
  });
  await w.platform.identity.addMember(w.as(w.ngoA), { email: 'meera@asha.org', displayName: 'Meera', roles: [] });
  await w.platform.identity.addMember(w.as(w.ngoA), { email: 'volunteer@gmail.test', displayName: 'Volunteer', roles: [] });
});
afterAll(async () => {
  await app.close();
  await w.close();
});

describe('an operator configures an organisation sign-in from the console', () => {
  it('starts with local sign-in only and the shared provider not opted into', async () => {
    const view = await control.signIn.get(principal, 'Asha');
    expect(view.organisation).toMatchObject({ code: 'asha', status: 'active' });
    expect(view.policy).toEqual({ passwordEnabled: true, emailCodeEnabled: true, passkeyEnabled: false, minimumAssurance: 'aal1' });
    expect(view.shared).toEqual([{ id: 'google', label: 'Google', issuer: SHARED, allowedDomains: [], optIn: null }]);
    expect(view.own).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers?tenant=asha' })).json()).toEqual([]);
  });

  it('needs a reason for every change', async () => {
    await expectCode(control.signIn.savePolicy(principal, 'asha', { passwordEnabled: true, emailCodeEnabled: true, minimumAssurance: 'aal1' }, ' ', await stepUp()), 'validation_failed');
  });

  it('saves the organisation’s own provider without ever returning or auditing its secret', async () => {
    const view = await control.signIn.saveProvider(
      principal, 'asha',
      { id: 'asha-idp', label: 'Asha staff', issuer: OWN, clientId: 'asha-client', clientSecret: SECRET, allowedDomains: ['Asha.org'] },
      'Asha moved to its own identity provider', await stepUp(),
    );
    expect(view.own).toEqual([expect.objectContaining({ id: 'asha-idp', clientId: 'asha-client', allowedDomains: ['asha.org'], secretSet: true, optIn: expect.objectContaining({ enabled: false }) })]);
    expect(JSON.stringify(view)).not.toContain(SECRET);

    const [stored] = await w.platform.db.asSystem((tx) => tx.query<{ secret_enc: string; config: unknown }>(`select secret_enc, config from connector where key = 'oidc:asha-idp'`));
    expect(stored!.secret_enc).not.toContain(SECRET);
    expect(JSON.stringify(stored!.config)).not.toContain(SECRET);
    const audits = await w.platform.db.asSystem((tx) =>
      tx.query<{ detail: unknown; step_up_id: string | null; permission: string }>(`select detail, step_up_id, permission from platform_audit where action = 'organisation.sign_in.provider_saved'`),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ permission: 'sign_in', step_up_id: expect.any(String) });
    expect(JSON.stringify(audits[0]!.detail)).not.toContain(SECRET);
    const tenantAudit = await w.platform.db.asSystem((tx) => tx.query<{ after: unknown }>(`select after from audit_event where tenant_id = $1 and action like 'organisation.sign_in.%'`, [w.ngoA]));
    expect(JSON.stringify(tenantAudit)).not.toContain(SECRET);
    expect(JSON.stringify(tenantAudit)).toContain('Asha moved to its own identity provider');
  });

  it('keeps the stored secret when a change leaves it out, and refuses a new provider without one', async () => {
    await control.signIn.saveProvider(principal, 'asha', { id: 'asha-idp', label: 'Asha team', issuer: OWN, clientId: 'asha-client', allowedDomains: ['asha.org'] }, 'Rename', await stepUp());
    expect((await control.signIn.get(principal, 'asha')).own[0]).toMatchObject({ label: 'Asha team', secretSet: true });
    await expectCode(
      control.signIn.saveProvider(principal, 'asha', { id: 'other', label: 'Other', issuer: OWN, clientId: 'x', allowedDomains: ['asha.org'] }, 'Add', await stepUp()),
      'validation_failed',
    );
    await expectCode(
      control.signIn.saveProvider(principal, 'asha', { id: 'nodomain', label: 'No domains', issuer: OWN, clientId: 'x', clientSecret: 's', allowedDomains: [] }, 'Add', await stepUp()),
      'validation_failed',
    );
  });

  it('tests a provider as sign-in will read it, without changing anything', async () => {
    const own = await control.signIn.testProvider(principal, 'asha', 'asha-idp');
    expect(own.ok).toBe(true);
    expect(own.checks.map((c) => c.name)).toEqual(['discovery', 'issuer', 'endpoints', 'signing keys']);
    const shared = await control.signIn.testProvider(principal, 'asha', 'google');
    expect(shared.ok).toBe(false);
    expect(shared.checks.find((c) => c.name === 'issuer')).toMatchObject({ ok: false });
    await expectCode(control.signIn.testProvider(principal, 'asha', 'missing'), 'not_found');
  });

  it('switches the own provider on, and the member signs in through it with the stored secret', async () => {
    await control.signIn.setProviderPolicy(principal, 'asha', 'asha-idp', { enabled: true, assurance: 'aal1' }, 'Go live', await stepUp());
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers?tenant=asha' })).json()).toEqual([{ id: 'asha-idp', label: 'Asha team' }]);
    const state = await startLogin('asha-idp');
    nextToken = (nonce) => idToken(OWN, 'asha-client', 'meera@asha.org', nonce);
    const res = await callback(state);
    expect(res.headers.location).toBe('/');
    expect(tokenSecrets.at(-1)).toBe(SECRET);
  });

  it('limits the shared provider opt-in to the organisation’s own domains', async () => {
    await control.signIn.setProviderPolicy(principal, 'asha', 'google', { enabled: true, assurance: 'aal1', allowedDomains: ['asha.org'] }, 'Staff only', await stepUp());
    expect((await control.signIn.get(principal, 'asha')).shared[0]!.optIn).toMatchObject({ enabled: true, allowedDomains: ['asha.org'] });

    let state = await startLogin('google');
    nextToken = (nonce) => idToken(SHARED, 'shared-client', 'volunteer@gmail.test', nonce);
    // The sign-in page keeps its own wording for each refusal key; the address carries no text (DEF-30).
    expect(new URL(String((await callback(state)).headers.location), 'https://ngo.test').searchParams.get('reason')).toBe('emailDomain');

    state = await startLogin('google');
    nextToken = (nonce) => idToken(SHARED, 'shared-client', 'meera@asha.org', nonce);
    expect((await callback(state)).headers.location).toBe('/');
    await expectCode(control.signIn.setProviderPolicy(principal, 'asha', 'google', { enabled: true, assurance: 'aal1', allowedDomains: ['not a domain'] }, 'Bad', await stepUp()), 'validation_failed');
  });

  it('keeps passwords on while fewer than two administrators can sign in another way', async () => {
    await expect(
      control.signIn.savePolicy(principal, 'asha', { passwordEnabled: false, emailCodeEnabled: false, minimumAssurance: 'aal1' }, 'Single sign-on only', await stepUp()),
    ).rejects.toThrow(/two active sign-in administrators/);
    expect((await control.signIn.get(principal, 'asha')).policy.passwordEnabled).toBe(true);
    const view = await control.signIn.savePolicy(principal, 'asha', { passwordEnabled: true, emailCodeEnabled: false, minimumAssurance: 'aal1' }, 'No email codes', await stepUp());
    expect(view.policy).toEqual({ passwordEnabled: true, emailCodeEnabled: false, passkeyEnabled: false, minimumAssurance: 'aal1' });
  });

  it('removes the own provider, forgets its secret and stops offering it', async () => {
    const [before] = await w.platform.db.asSystem((tx) => tx.query<{ access_version: number }>(`select access_version from tenant where id = $1`, [w.ngoA]));
    const view = await control.signIn.removeProvider(principal, 'asha', 'asha-idp', 'Back to the shared provider', await stepUp());
    expect(view.own).toEqual([]);
    const [row] = await w.platform.db.asSystem((tx) => tx.query<{ secret_enc: string | null; enabled: boolean }>(`select secret_enc, enabled from connector where key = 'oidc:asha-idp'`));
    expect(row).toEqual({ secret_enc: null, enabled: false });
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers?tenant=asha' })).json()).toEqual([{ id: 'google', label: 'Google' }]);
    const [after] = await w.platform.db.asSystem((tx) => tx.query<{ access_version: number }>(`select access_version from tenant where id = $1`, [w.ngoA]));
    expect(after!.access_version).toBeGreaterThan(before!.access_version);
    await expectCode(control.signIn.removeProvider(principal, 'asha', 'asha-idp', 'Again', await stepUp()), 'not_found');
  });

  it('leaves the other organisation untouched and refuses unknown organisations', async () => {
    const bodhi = await control.signIn.get(principal, 'bodhi');
    expect(bodhi.own).toEqual([]);
    expect(bodhi.shared[0]!.optIn).toBeNull();
    await expectCode(control.signIn.get(principal, 'nobody'), 'not_found');
  });
});
