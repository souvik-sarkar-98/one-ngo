import { importPKCS8, SignJWT } from 'jose';
import { DriveFileStore, GcsFileStore, gcsJsonClient, S3FileStore, type FileStore } from '@onengo/kernel/files';

export const STORAGE_PROVIDERS = ['gcs', 's3', 'drive'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export interface StorageConfig {
  provider: StorageProvider;
  bucket?: string;
  region?: string;
  prefix?: string;
  endpoint?: string;
  credential?: string;
  folderId?: string;
}

const GCS_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** The storage connector config, or undefined when a required field is missing or the wrong shape. */
export function parseStorageConfig(config: unknown): StorageConfig | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const c = config as Record<string, unknown>;
  if (c.provider !== 'gcs' && c.provider !== 's3' && c.provider !== 'drive') return undefined;
  const prefix = optionalText(c.prefix, 200);
  if (c.prefix !== undefined && prefix === undefined) return undefined;
  if (c.provider === 'drive') {
    if (typeof c.credential !== 'string' || typeof c.folderId !== 'string' || !c.folderId) return undefined;
    return { provider: 'drive', credential: c.credential, folderId: c.folderId };
  }
  const bucket = optionalText(c.bucket, 222);
  if (!bucket) return undefined;
  if (c.provider === 'gcs') return { provider: 'gcs', bucket, ...(prefix ? { prefix } : {}) };
  const region = optionalText(c.region, 32);
  if (!region) return undefined;
  const endpoint = c.endpoint === undefined ? undefined : optionalText(c.endpoint, 2000);
  if (c.endpoint !== undefined && !endpoint) return undefined;
  return { provider: 's3', bucket, region, ...(prefix ? { prefix } : {}), ...(endpoint ? { endpoint } : {}) };
}

/** A service-account JSON key exchanged for a Cloud Storage access token. */
export function serviceAccountToken(keyJson: string, fetchFn: typeof fetch = fetch): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  let signing: ReturnType<typeof importPKCS8> | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const parsed = JSON.parse(keyJson) as { client_email?: unknown; private_key?: unknown; token_uri?: unknown };
    if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
      throw new Error('The service account key needs client_email and private_key.');
    }
    signing ??= importPKCS8(parsed.private_key, 'RS256');
    const key = await signing;
    const tokenUri = typeof parsed.token_uri === 'string' && parsed.token_uri ? parsed.token_uri : TOKEN_URI;
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: GCS_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(parsed.client_email)
      .setAudience(tokenUri)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const response = await fetchFn(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Cloud Storage token request failed with ${response.status}.`);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('Cloud Storage token request returned no access token.');
    cached = { token: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
    return cached.token;
  };
}

/** The file store for one saved storage connector. Drive needs `accessToken` for its oauth credential. */
export function openStorageStore(
  config: StorageConfig,
  secrets: Record<string, string>,
  options: { accessToken?: () => Promise<string>; fetch?: typeof fetch } = {},
): FileStore {
  const fetchFn = options.fetch;
  if (config.provider === 'gcs') {
    const key = secrets.serviceAccountKey;
    if (!key) throw new Error('The Cloud Storage connector has no service account key.');
    return new GcsFileStore(gcsJsonClient({ bucket: config.bucket!, accessToken: serviceAccountToken(key, fetchFn), ...(fetchFn ? { fetch: fetchFn } : {}) }), folder(config.prefix));
  }
  if (config.provider === 's3') {
    if (!secrets.accessKeyId || !secrets.secretAccessKey) throw new Error('The S3 connector needs an access key and a secret key.');
    return new S3FileStore({
      bucket: config.bucket!,
      region: config.region!,
      ...(config.prefix ? { prefix: config.prefix } : {}),
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      accessKeyId: secrets.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    });
  }
  if (!options.accessToken) throw new Error('The Drive connector has no account to sign in with.');
  return new DriveFileStore({ folderId: config.folderId!, accessToken: options.accessToken, ...(fetchFn ? { fetch: fetchFn } : {}) });
}

/** Secrets a provider must have before the connector can be enabled. Drive uses an oauth connector instead. */
export function storageSecretNames(provider: string | undefined): string[] {
  if (provider === 'gcs') return ['serviceAccountKey'];
  if (provider === 's3') return ['accessKeyId', 'secretAccessKey'];
  return [];
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\r\n]/.test(text)) return undefined;
  return text;
}

function folder(prefix: string | undefined): string {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}
