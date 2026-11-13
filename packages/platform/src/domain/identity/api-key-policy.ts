import { validationFailed } from '@onengo/kernel/errors';

/** Id prefix of the actor an API key acts as: `api:<name>`. */
export const API_ACTOR_PREFIX = 'api:';
/** Organisation setting that overrides the per-minute request limit of a key. */
export const API_RATE_SETTING = 'api.rateLimitPerMinute';
/** Exact browser origins allowed to read this organisation's data feeds. Empty means servers only. */
export const API_CORS_SETTING = 'api.corsOrigins';
/** Permission needed to list, create and revoke API keys. */
export const API_KEYS_PERMISSION = 'admin:api-keys';

/** Largest per-minute request limit an organisation can set for a key. */
const MAX_RATE_PER_MINUTE = 100_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isApiKeyId = (id: string): boolean => UUID.test(id);

export const apiActorId = (keyName: string): string => `${API_ACTOR_PREFIX}${keyName}`;

/** The credential a caller presents: `<id>.<secret>`; the secret is shown once, when the key is created. */
export const apiKeyToken = (id: string, secret: string): string => `${id}.${secret}`;

/** Splits `<id>.<secret>`; empty parts when the credential has no dot, and a missing or malformed id is the caller's to refuse. */
export function parseApiKeyToken(credential: string): { id: string; secret: string } {
  const dot = credential.indexOf('.');
  return { id: dot > 0 ? credential.slice(0, dot) : '', secret: dot > 0 ? credential.slice(dot + 1) : '' };
}

/** A key name of up to 100 letters, digits, spaces, dots, dashes or underscores; throws the validation error otherwise. */
export function keyNameOf(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100 || !/^[\w .-]+$/.test(name)) {
    throw validationFailed('Give the key a name of up to 100 letters, digits, spaces, dots, dashes or underscores.', [
      { path: '/name', message: 'is not a valid key name' },
    ]);
  }
  return name;
}

/** The per-minute limit stored for a key, or `fallback` when the stored value is not a usable whole number of at least one. */
export function rateLimitOf(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_RATE_PER_MINUTE) : fallback;
}

const MAX_ORIGINS = 10;

/** An exact `http` or `https` origin: no path, query, hash or trailing slash, and not `*`. */
export function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

/** Origins stored for an organisation. Anything that is not a list of exact origins is ignored. */
export function corsOriginsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && isExactOrigin(item) && !out.includes(item)) out.push(item);
    if (out.length === MAX_ORIGINS) break;
  }
  return out;
}

/** The list an administrator is saving. Throws when an entry is not an exact origin, or there are more than ten. */
export function requireCorsOrigins(value: unknown): string[] {
  const items = Array.isArray(value) ? value : null;
  const origins = items?.filter((item): item is string => typeof item === 'string' && isExactOrigin(item));
  if (!items || items.length > MAX_ORIGINS || origins?.length !== items.length || new Set(items).size !== items.length) {
    throw validationFailed('Browser origins are at most 10 exact http or https origins, with no path.', [
      { path: 'corsOrigins', message: 'Each entry is an http or https origin, with no path, query or *.' },
    ]);
  }
  return origins;
}
