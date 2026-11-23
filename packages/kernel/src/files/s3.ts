import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { InfrastructureError } from '../errors/index.js';
import type { FileStore } from '../ports/index.js';
import { storageKey } from './key.js';

export interface S3FileStoreOptions {
  bucket: string;
  region: string;
  /** Optional folder inside the bucket. A missing trailing slash is added. */
  prefix?: string;
  /** HTTPS address of an S3-compatible store. Absent means AWS. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();

/** AWS SigV4 signing key for one date, region and service. */
export function s3SigningKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
}

export interface S3SignedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  amzDate: string;
}

/**
 * The Authorization header for one S3 request. Header names are lower case.
 * `payloadHash` is a hex SHA-256 or the literal `UNSIGNED-PAYLOAD`.
 */
export function s3Authorization(input: S3SignedRequest): string {
  const signed = Object.keys(input.headers).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = signed.map((name) => `${name}:${input.headers[name]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonical = [input.method, input.url.pathname || '/', canonicalQuery(input.url), canonicalHeaders, signed.join(';'), input.payloadHash].join('\n');
  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', s3SigningKey(input.secretAccessKey, date, input.region)).update(stringToSign, 'utf8').digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function encodeObject(object: string): string {
  return object.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/** Amazon S3, or an S3-compatible store when `endpoint` is set. Objects are signed with SigV4. */
export class S3FileStore implements FileStore {
  private readonly fetchFn: typeof fetch;
  private readonly prefix: string;
  constructor(private readonly options: S3FileStoreOptions) {
    this.fetchFn = options.fetch ?? fetch;
    const prefix = options.prefix ?? '';
    this.prefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  }

  async put(key: string, body: Readable, contentType = 'application/octet-stream'): Promise<void> {
    const response = await this.call('PUT', key, body, contentType);
    if (!response.ok) throw new Error(`S3 upload failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  async get(key: string): Promise<Readable> {
    const response = await this.call('GET', key);
    if (response.status === 404) throw new InfrastructureError('not_found', 'File not found.');
    if (!response.ok || !response.body) throw new Error(`S3 download failed with ${response.status}.`);
    return Readable.fromWeb(response.body as never);
  }

  async delete(key: string): Promise<void> {
    const response = await this.call('DELETE', key);
    if (response.status !== 404 && !response.ok) throw new Error(`S3 delete failed with ${response.status}.`);
  }

  private async call(method: string, key: string, body?: Readable, contentType?: string): Promise<Response> {
    const object = `${this.prefix}${storageKey(key)}`;
    const url = this.objectUrl(object);
    const date = amzDate(this.options.now?.() ?? new Date());
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-date': date,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    };
    if (contentType) headers['content-type'] = contentType;
    headers.authorization = s3Authorization({
      method,
      url,
      headers,
      payloadHash: 'UNSIGNED-PAYLOAD',
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      region: this.options.region,
      amzDate: date,
    });
    return this.fetchFn(url, {
      method,
      headers,
      ...(body ? { body: Readable.toWeb(body) as ReadableStream, duplex: 'half' } : {}),
      signal: AbortSignal.timeout(120_000),
    } as RequestInit);
  }

  private objectUrl(object: string): URL {
    const path = encodeObject(object);
    if (this.options.endpoint) {
      const base = new URL(this.options.endpoint);
      const root = base.pathname.replace(/\/$/, '');
      return new URL(`${root}/${encodeURIComponent(this.options.bucket)}/${path}`, base);
    }
    return new URL(`https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${path}`);
  }
}
