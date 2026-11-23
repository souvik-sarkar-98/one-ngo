import { Readable } from 'node:stream';
import { InfrastructureError } from '../errors/index.js';
import type { FileStore } from '../ports/index.js';
import { storageKey } from './key.js';

export interface DriveFileStoreOptions {
  folderId: string;
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
}

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

/** Google Drive. The platform key is stored in `appProperties.onengoKey`, so reads do not need a schema change. */
export class DriveFileStore implements FileStore {
  private readonly fetchFn: typeof fetch;
  constructor(private readonly options: DriveFileStoreOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  async put(key: string, body: Readable, contentType = 'application/octet-stream'): Promise<void> {
    const name = storageKey(key);
    const existing = await this.find(name);
    const boundary = `onengo-${Date.now().toString(16)}`;
    const meta = JSON.stringify({ name, parents: [this.options.folderId], appProperties: { onengoKey: name } });
    const bytes = await readAll(body);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const url = existing ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=multipart` : UPLOAD;
    const response = await this.fetchFn(url, {
      method: existing ? 'PATCH' : 'POST',
      headers: { authorization: await this.auth(), 'content-type': `multipart/related; boundary=${boundary}` },
      body: payload,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Drive upload failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  async get(key: string): Promise<Readable> {
    const id = await this.find(storageKey(key));
    if (!id) throw new InfrastructureError('not_found', 'File not found.');
    const response = await this.fetchFn(`${DRIVE}/${id}?alt=media`, { headers: { authorization: await this.auth() }, signal: AbortSignal.timeout(120_000) });
    if (response.status === 404) throw new InfrastructureError('not_found', 'File not found.');
    if (!response.ok || !response.body) throw new Error(`Drive download failed with ${response.status}.`);
    return Readable.fromWeb(response.body as never);
  }

  async delete(key: string): Promise<void> {
    const id = await this.find(storageKey(key));
    if (!id) return;
    const response = await this.fetchFn(`${DRIVE}/${id}`, { method: 'DELETE', headers: { authorization: await this.auth() }, signal: AbortSignal.timeout(120_000) });
    if (response.status !== 404 && !response.ok) throw new Error(`Drive delete failed with ${response.status}.`);
  }

  private async auth(): Promise<string> {
    return `Bearer ${await this.options.accessToken()}`;
  }

  private async find(key: string): Promise<string | undefined> {
    const quote = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `appProperties has { key='onengoKey' and value='${quote}' } and '${this.options.folderId}' in parents and trashed = false`;
    const url = `${DRIVE}?pageSize=1&fields=files(id)&q=${encodeURIComponent(q)}`;
    const response = await this.fetchFn(url, { headers: { authorization: await this.auth() }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Drive search failed with ${response.status}.`);
    const body = (await response.json()) as { files?: { id?: string }[] };
    return body.files?.[0]?.id;
  }
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
