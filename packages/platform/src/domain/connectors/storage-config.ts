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
