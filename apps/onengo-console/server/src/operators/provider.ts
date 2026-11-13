import { decodeJwt, jwtVerify, createRemoteJWKSet } from 'jose';
import { pkceChallenge, remoteJwks, safeNextPath, verifyIdToken, type ExternalAuthResult, type OidcDiscovery } from '@onengo/kernel/oidc';
import { opaque, type LoginState } from './security.js';

export interface ProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  audience: string;
  mfaAcr?: string;
  iapAudience?: string;
}

export class OperatorProvider {
  private discovery?: Promise<OidcDiscovery>;
  constructor(readonly config: ProviderConfig, private readonly fetcher: typeof fetch = fetch) {}

  /** Reads the provider's discovery document, so a wrong issuer stops the console at start-up. */
  async check(): Promise<void> {
    const metadata = await this.metadata();
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (!metadata[field]) throw new Error(`Operator identity provider discovery has no ${field}.`);
    }
  }

  private metadata(): Promise<OidcDiscovery> {
    this.discovery ??= this.fetcher(`${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Operator identity provider is unavailable.');
        const value = await response.json() as OidcDiscovery;
        if (value.issuer !== this.config.issuer) throw new Error('Operator identity provider issuer mismatch.');
        return value;
      })
      .catch((error: unknown) => {
        this.discovery = undefined;
        throw error;
      });
    return this.discovery;
  }

  async authorize(next: string, stepUp?: LoginState['stepUp']): Promise<{ url: string; login: LoginState }> {
    const metadata = await this.metadata();
    const login = { state: opaque(), nonce: opaque(), verifier: opaque(48), nextPath: safeNextPath(next), stepUp };
    const url = new URL(metadata.authorization_endpoint);
    const params: Record<string, string> = {
      client_id: this.config.clientId, response_type: 'code', scope: 'openid profile email',
      redirect_uri: this.config.redirectUri, state: login.state, nonce: login.nonce,
      code_challenge: pkceChallenge(login.verifier), code_challenge_method: 'S256',
    };
    if (stepUp) {
      params.prompt = 'login';
      params.max_age = '0';
      if (this.config.mfaAcr) params.acr_values = this.config.mfaAcr;
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { url: url.toString(), login };
  }

  async callback(code: string, login: LoginState): Promise<{ identity: ExternalAuthResult; tokens: unknown }> {
    const metadata = await this.metadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri, code_verifier: login.verifier,
    });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);
    const response = await this.fetcher(metadata.token_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!response.ok) throw new Error('Operator identity provider rejected the authorization code.');
    const tokens = await response.json() as { id_token?: string };
    if (!tokens.id_token) throw new Error('Operator identity provider returned no ID token.');
    const identity = await verifyIdToken(tokens.id_token, {
      issuer: this.config.issuer, audience: this.config.clientId, nonce: login.nonce, keys: remoteJwks(metadata.jwks_uri),
    });
    this.requireFreshMfa(identity);
    return { identity, tokens };
  }

  async verifyBackChannel(token: string): Promise<{ issuer: string; sid: string }> {
    const metadata = await this.metadata();
    const { payload } = await jwtVerify(token, remoteJwks(metadata.jwks_uri), {
      issuer: this.config.issuer, audience: this.config.clientId, algorithms: ['RS256', 'ES256'],
      requiredClaims: ['exp', 'iat', 'sub', 'sid'],
    });
    const events = payload.events as Record<string, unknown> | undefined;
    if (!events?.['http://schemas.openid.net/event/backchannel-logout'] || typeof payload.sid !== 'string') {
      throw new Error('Back-channel logout token is invalid.');
    }
    return { issuer: String(payload.iss), sid: payload.sid };
  }

  requireFreshMfa(identity: ExternalAuthResult, now = Math.floor(Date.now() / 1000)): void {
    if (!identity.authTime || now - identity.authTime > 300 || identity.authTime > now + 60) throw new Error('Fresh operator authentication is required.');
    if (!identity.amr.includes('mfa')) throw new Error('The identity provider did not prove multi-factor authentication.');
    if (this.config.mfaAcr && identity.acr !== this.config.mfaAcr) throw new Error('The required operator assurance level was not met.');
  }
}

const IAP_ISSUER = 'https://cloud.google.com/iap';
const IAP_KEYS = createRemoteJWKSet(new URL('https://www.gstatic.com/iap/verify/public_key-jwk'));

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `OPERATOR_LOCAL_WITHOUT_IAP=1` runs the console without Identity-Aware Proxy. The console dev script sets it.
 * Refused on any cloud host and unless the console's own address is on this machine.
 */
export function localWithoutIap(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OPERATOR_LOCAL_WITHOUT_IAP !== '1') return false;
  if (env.GAE_SERVICE || env.K_SERVICE || env.GOOGLE_CLOUD_PROJECT || env.FUNCTION_TARGET) {
    throw new Error('OPERATOR_LOCAL_WITHOUT_IAP cannot be used on a cloud host.');
  }
  let host = '';
  try {
    host = new URL(env.OPERATOR_PUBLIC_BASE_URL ?? '').hostname;
  } catch {
    host = '';
  }
  if (!LOCAL_HOSTS.has(host)) throw new Error('OPERATOR_LOCAL_WITHOUT_IAP needs OPERATOR_PUBLIC_BASE_URL on localhost or 127.0.0.1.');
  return true;
}

/**
 * Verifies IAP at the application boundary; member and arbitrary bearer tokens are never accepted.
 * A missing audience skips the check. Only local mode starts that way: cloud start-up calls
 * `iapAudience` and refuses to boot without `OPERATOR_IAP_AUDIENCE`.
 */
export async function verifyIap(assertion: string | undefined, audience: string | undefined): Promise<void> {
  if (!audience) return;
  if (!assertion) throw new Error('Identity-Aware Proxy assertion is required.');
  const hint = decodeJwt(assertion);
  if (hint.iss !== IAP_ISSUER) throw new Error('Identity-Aware Proxy issuer is invalid.');
  await jwtVerify(assertion, IAP_KEYS, { issuer: IAP_ISSUER, audience, algorithms: ['ES256'], requiredClaims: ['exp', 'iat', 'sub'] });
}
