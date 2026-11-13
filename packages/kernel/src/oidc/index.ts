import { createHash } from 'node:crypto';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

const NEXT_BASE = 'https://next.invalid';
const NEXT_MAX = 2000;
const UNSAFE_NEXT = /[\u0000-\u001f\u007f\\]/;
const unsafeStart = (path: string) => !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\');

export function safeNextPath(next: string | null | undefined): string {
  if (typeof next !== 'string' || !next || next.length > NEXT_MAX || UNSAFE_NEXT.test(next) || unsafeStart(next)) return '/';
  let decoded = next;
  for (let i = 0; i < 3; i++) {
    try {
      const once = decodeURIComponent(decoded);
      if (once === decoded) break;
      if (UNSAFE_NEXT.test(once) || unsafeStart(once)) return '/';
      decoded = once;
    } catch {
      break;
    }
  }
  try {
    const url = new URL(next, NEXT_BASE);
    if (url.origin !== NEXT_BASE) return '/';
    const path = `${url.pathname}${url.search}${url.hash}`;
    return unsafeStart(path) ? '/' : path;
  } catch {
    return '/';
  }
}

export const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
export interface ExternalAuthResult {
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  authTime?: number;
  amr: string[];
  acr?: string;
  sid?: string;
}
export interface VerifyIdTokenOptions {
  issuer: string | string[];
  audience: string;
  nonce: string;
  keys: JWTVerifyGetKey;
  clockToleranceSeconds?: number;
  nowSeconds?: number;
}

export async function verifyIdToken(token: string, options: VerifyIdTokenOptions): Promise<ExternalAuthResult> {
  const clockTolerance = options.clockToleranceSeconds ?? 60;
  const { payload } = await jwtVerify(token, options.keys, {
    algorithms: ['RS256', 'ES256'],
    issuer: options.issuer,
    audience: options.audience,
    clockTolerance,
    requiredClaims: ['exp', 'iat', 'sub'],
  });
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const audience = payload.aud;
  if ((Array.isArray(audience) && audience.length > 1 && payload.azp !== options.audience) || Number(payload.iat) >= now + clockTolerance || payload.nonce !== options.nonce) {
    throw new Error('OpenID Connect token claims are invalid.');
  }
  return resultOf(payload);
}

function resultOf(payload: JWTPayload): ExternalAuthResult {
  return {
    issuer: String(payload.iss),
    subject: String(payload.sub),
    email: typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : undefined,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    authTime: typeof payload.auth_time === 'number' ? payload.auth_time : undefined,
    amr: Array.isArray(payload.amr) ? payload.amr.filter((value): value is string => typeof value === 'string') : [],
    acr: typeof payload.acr === 'string' ? payload.acr : undefined,
    sid: typeof payload.sid === 'string' ? payload.sid : undefined,
  };
}

/** Remote key set with bounded cache and one immediate refresh path supplied by jose on an unknown key id. */
export function remoteJwks(uri: string, cacheMaxAge = 60 * 60 * 1000): JWTVerifyGetKey {
  const keys = createRemoteJWKSet(new URL(uri), { cacheMaxAge, cooldownDuration: 0 });
  return async (header, token) => {
    if (!header.kid) throw new Error('OpenID Connect token has no key id.');
    try {
      return await keys(header, token);
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
        throw new Error('OpenID Connect signing key is not trusted.');
      }
      throw error;
    }
  };
}
