import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InfrastructureError } from '../errors/index.js';
import type { FileStore, FileStoreResolver } from '../ports/index.js';
export type { FileStore, FileStoreResolver } from '../ports/index.js';

/** The installation's one store, used by every organisation. */
export const PLATFORM_STORE = 'platform';

/** Every organisation on the installation's one store. A file recorded under any other reference is refused. */
export function singleStoreResolver(store: FileStore): FileStoreResolver {
  const platform = { ref: PLATFORM_STORE, store };
  return {
    forTenant: async () => platform,
    byRef(ref) {
      if (ref !== PLATFORM_STORE) throw new Error(`No file store is configured for '${ref}'.`);
      return store;
    },
  };
}

const KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
const checkKey = (key: string) => {
  if (!KEY.test(key)) throw new Error(`Invalid storage key '${key}'.`);
  return key;
};
const missing = () => new InfrastructureError('not_found', 'File not found.');

export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}
  async put(key: string, body: Readable): Promise<void> {
    const path = this.path(key);
    const partial = `${path}.part`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await pipeline(body, createWriteStream(partial, { flags: 'wx' }));
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
  async get(key: string): Promise<Readable> {
    const path = this.path(key);
    try { await stat(path); } catch { throw missing(); }
    return createReadStream(path);
  }
  delete(key: string): Promise<void> { return rm(this.path(key), { force: true }); }
  private path(key: string) { return join(this.root, ...checkKey(key).split('/')); }
}

export interface GcsClient {
  upload(object: string, body: Readable, contentType: string): Promise<void>;
  download(object: string): Promise<Readable | null>;
  remove(object: string): Promise<void>;
}
export class GcsFileStore implements FileStore {
  constructor(private readonly client: GcsClient, private readonly prefix = '') {}
  put(key: string, body: Readable, contentType = 'application/octet-stream') { return this.client.upload(this.object(key), body, contentType); }
  async get(key: string) { return (await this.client.download(this.object(key))) ?? Promise.reject(missing()); }
  delete(key: string) { return this.client.remove(this.object(key)); }
  private object(key: string) { return `${this.prefix}${checkKey(key)}`; }
}
export interface GcsJsonClientOptions {
  bucket: string;
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
const GCS_API = 'https://storage.googleapis.com';
export function gcsJsonClient(options: GcsJsonClientOptions): GcsClient {
  const call = options.fetch ?? fetch;
  const bucket = encodeURIComponent(options.bucket);
  const signal = () => AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const auth = async () => ({ authorization: `Bearer ${await options.accessToken()}` });
  const objectUrl = (object: string) => `${GCS_API}/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`;
  return {
    async upload(object, body, contentType) {
      const response = await call(`${GCS_API}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(object)}`, {
        method: 'POST', headers: { ...(await auth()), 'content-type': contentType },
        body: Readable.toWeb(body) as ReadableStream, duplex: 'half', signal: signal(),
      } as RequestInit);
      if (!response.ok) throw new Error(`Cloud Storage upload failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
    },
    async download(object) {
      const response = await call(`${objectUrl(object)}?alt=media`, { headers: await auth(), signal: signal() });
      if (response.status === 404) return null;
      if (!response.ok || !response.body) throw new Error(`Cloud Storage download failed with ${response.status}.`);
      return Readable.fromWeb(response.body as never);
    },
    async remove(object) {
      const response = await call(objectUrl(object), { method: 'DELETE', headers: await auth(), signal: signal() });
      if (response.status !== 404 && !response.ok) throw new Error(`Cloud Storage delete failed with ${response.status}.`);
    },
  };
}
const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
export function metadataServerToken(fetchFn: typeof fetch = fetch): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const response = await fetchFn(METADATA_TOKEN, { headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Metadata server token request failed with ${response.status}.`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return cached.token;
  };
}
export const opensInline = (mime: string): boolean => mime.startsWith('image/') || mime === 'application/pdf';
