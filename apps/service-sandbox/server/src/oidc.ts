import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { demoSubject, GOOGLE, OPERATOR, PATHS } from './constants.js';
import { basic, escapeHtml, readForm, redirect, sendHtml, sendJson, type Handler } from './http.js';
import type { FixtureLog } from './log.js';

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string | undefined;
  challenge: string;
  email: string;
  expiresAt: number;
}

const CLIENTS: ReadonlyMap<string, string> = new Map([
  [GOOGLE.clientId, GOOGLE.clientSecret],
  [OPERATOR.clientId, OPERATOR.clientSecret],
]);

const CODE_TTL_MS = 5 * 60 * 1000;
const ID_TOKEN_TTL_S = 3600;

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export interface Oidc {
  routes: Handler;
  /** Signs an ID token as the token endpoint would; used by the tests. */
  idToken(claims: { email: string; nonce?: string; clientId?: string }): Promise<string>;
}

/**
 * OpenID Connect provider at the fixture origin: discovery, an authorize page that asks for an email,
 * the code exchange (PKCE S256 and the demo client secret) and the signing keys. ID tokens say email_verified: true;
 * one-ngo still signs in only an existing member with that email. Tokens for the operator client also
 * report multi-factor sign-in (`amr`), which the operator console requires.
 */
export async function oidc(origin: string, log: FixtureLog): Promise<Oidc> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = `demo-${randomBytes(4).toString('hex')}`;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();

  const idToken = async ({ email, nonce, clientId = GOOGLE.clientId }: { email: string; nonce?: string; clientId?: string }) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      email,
      email_verified: true,
      azp: clientId,
      auth_time: now,
      ...(clientId === OPERATOR.clientId ? { amr: ['pwd', 'mfa'] } : {}),
      ...(nonce ? { nonce } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer(origin)
      .setAudience(clientId)
      .setSubject(demoSubject(email))
      .setIssuedAt(now)
      .setExpirationTime(now + ID_TOKEN_TTL_S)
      .sign(privateKey);
  };

  const authorizePage = (params: URLSearchParams, error?: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Demo sign-in</title>
<style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.5rem}input[type=email]{width:100%;box-sizing:border-box}.err{color:#a00}</style></head>
<body><h1>Demo sign-in</h1>
<p>${params.get('client_id') === OPERATOR.clientId
    ? 'Integration fixture standing in for the operator identity provider. It reports a multi-factor sign-in. Enter the email of a local operator.'
    : 'Integration fixture standing in for Google. Enter the email of an existing member of the organisation.'}</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${PATHS.authorize}">
${[...params].map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('\n')}
<p><label>Email<br><input type="email" name="email" required autofocus></label></p>
<p><button name="decision" value="allow">Sign in</button> <button name="decision" value="deny" formnovalidate>Cancel</button></p>
</form></body></html>`;

  const checkAuthorize = (p: URLSearchParams): string | null => {
    if (!CLIENTS.has(p.get('client_id') ?? '')) return `Unknown client_id. Use ${GOOGLE.clientId} or ${OPERATOR.clientId}.`;
    if (p.get('response_type') !== 'code') return 'response_type must be code.';
    if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return 'A PKCE S256 code_challenge is required.';
    const redirectUri = p.get('redirect_uri') ?? '';
    try {
      new URL(redirectUri);
    } catch {
      return 'redirect_uri is not an address.';
    }
    if (!p.get('state')) return 'state is required.';
    return null;
  };

  const routes: Handler = async (req, res) => {
    const path = req.url.pathname;
    if (req.method === 'GET' && path === PATHS.discovery) {
      log.add('oidc', 'Discovery document');
      return sendJson(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}${PATHS.authorize}`,
        token_endpoint: `${origin}${PATHS.token}`,
        jwks_uri: `${origin}${PATHS.jwks}`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'auth_time', 'amr', 'email', 'email_verified', 'nonce'],
      });
    }
    if (req.method === 'GET' && path === PATHS.jwks) {
      log.add('oidc', 'Signing keys');
      return sendJson(res, 200, { keys: [jwk] });
    }
    if (req.method === 'GET' && path === PATHS.authorize) {
      const params = req.url.searchParams;
      const problem = checkAuthorize(params);
      log.add('oidc', problem ? `Authorize refused: ${problem}` : 'Authorize page shown');
      return problem ? sendHtml(res, 400, `<p>${escapeHtml(problem)}</p>`) : sendHtml(res, 200, authorizePage(params));
    }
    if (req.method === 'POST' && path === PATHS.authorize) {
      const form = await readForm(req);
      const problem = checkAuthorize(form);
      if (problem) return sendHtml(res, 400, `<p>${escapeHtml(problem)}</p>`);
      const back = new URL(form.get('redirect_uri')!);
      back.searchParams.set('state', form.get('state')!);
      if (form.get('decision') === 'deny') {
        back.searchParams.set('error', 'access_denied');
        log.add('oidc', 'Sign-in cancelled');
        return redirect(res, back.toString());
      }
      const email = (form.get('email') ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
        const params = new URLSearchParams(form);
        params.delete('email');
        params.delete('decision');
        return sendHtml(res, 400, authorizePage(params, 'Enter an email address.'));
      }
      const code = randomBytes(24).toString('base64url');
      codes.set(code, {
        clientId: form.get('client_id')!,
        redirectUri: form.get('redirect_uri')!,
        nonce: form.get('nonce') ?? undefined,
        challenge: form.get('code_challenge')!,
        email,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      back.searchParams.set('code', code);
      log.add('oidc', `Code issued for ${email}`);
      return redirect(res, back.toString());
    }
    if (req.method === 'POST' && path === PATHS.token) {
      const form = await readForm(req);
      const creds = basic(req);
      const clientId = creds?.user ?? form.get('client_id') ?? '';
      const clientSecret = creds?.password ?? form.get('client_secret') ?? '';
      const expected = CLIENTS.get(clientId);
      if (expected === undefined || !sameText(clientSecret, expected)) {
        log.add('oidc', 'Token refused: wrong client id or secret');
        return sendJson(res, 401, { error: 'invalid_client' });
      }
      if (form.get('grant_type') !== 'authorization_code') return sendJson(res, 400, { error: 'unsupported_grant_type' });
      const code = form.get('code') ?? '';
      const pending = codes.get(code);
      codes.delete(code);
      if (!pending || pending.clientId !== clientId || pending.expiresAt < Date.now() || pending.redirectUri !== form.get('redirect_uri')) {
        log.add('oidc', 'Token refused: unknown, used or expired code');
        return sendJson(res, 400, { error: 'invalid_grant' });
      }
      if (s256(form.get('code_verifier') ?? '') !== pending.challenge) {
        log.add('oidc', 'Token refused: PKCE verifier does not match');
        return sendJson(res, 400, { error: 'invalid_grant', error_description: 'code_verifier does not match' });
      }
      log.add('oidc', `ID token issued for ${pending.email}`);
      return sendJson(res, 200, {
        access_token: randomBytes(24).toString('base64url'),
        token_type: 'Bearer',
        expires_in: ID_TOKEN_TTL_S,
        scope: 'openid email profile',
        id_token: await idToken({ email: pending.email, clientId: pending.clientId, ...(pending.nonce ? { nonce: pending.nonce } : {}) }),
      });
    }
    return false;
  };

  return { routes, idToken };
}
