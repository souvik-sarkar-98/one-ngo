import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { exportPKCS8, exportSPKI, importSPKI, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { DriveFileStore, s3Authorization } from '@onengo/kernel/files';
import { serviceAccountToken } from '../../../packages/platform/src/infrastructure/files/storage-connector.js';

describe('S3 SigV4', () => {
  it('matches the published AWS signature for a GET', () => {
    const url = new URL('https://examplebucket.s3.amazonaws.com/test.txt');
    const headers = {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'x-amz-date': '20130524T000000Z',
    };
    const authorization = s3Authorization({
      method: 'GET',
      url,
      headers,
      payloadHash: headers['x-amz-content-sha256'],
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      amzDate: '20130524T000000Z',
    });
    expect(authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('Google Drive files', () => {
  it('stores the platform key in appProperties and finds the file by it', async () => {
    const files = new Map<string, { key: string; folder: string; bytes: Buffer }>();
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      if (url.pathname === '/upload/drive/v3/files' || url.pathname.startsWith('/upload/drive/v3/files/')) {
        const raw = Buffer.from(await new Response(init?.body as never).arrayBuffer());
        const text = raw.toString('utf8');
        const key = /"onengoKey":"([^"]+)"/.exec(text)?.[1];
        const folder = /"parents":\["([^"]+)"\]/.exec(text)?.[1];
        if (!key || !folder) return new Response('missing metadata', { status: 400 });
        const id = url.pathname.split('/').pop() === 'files' ? 'made-1' : url.pathname.split('/').pop()!;
        files.set(id, { key, folder, bytes: raw });
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      if (url.pathname === '/drive/v3/files') {
        const q = url.searchParams.get('q') ?? '';
        const found = [...files.entries()].find(([, file]) => q.includes(file.key) && q.includes(file.folder));
        return new Response(JSON.stringify({ files: found ? [{ id: found[0] }] : [] }), { status: 200 });
      }
      const id = url.pathname.split('/').pop()!;
      const file = files.get(id);
      if (!file) return new Response('missing', { status: 404 });
      if (method === 'DELETE') {
        files.delete(id);
        return new Response(null, { status: 204 });
      }
      return new Response(file.bytes);
    };
    const store = new DriveFileStore({ folderId: 'folder-1', accessToken: async () => 'drive-token', fetch: fetchFn });
    await store.put('tenant/file-1', Readable.from([Buffer.from('drive-bytes')]), 'text/plain');
    const read = Buffer.concat(await readAll(await store.get('tenant/file-1')));
    expect(read.toString('utf8')).toContain('drive-bytes');
    expect(files.get('made-1')?.key).toBe('tenant/file-1');
    await store.delete('tenant/file-1');
    expect(files.size).toBe(0);
  });
});

describe('Cloud Storage service account', () => {
  it('exchanges a signed JWT for an access token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = await exportPKCS8(privateKey);
    const spki = await exportSPKI(publicKey);
    let assertion = '';
    const fetchFn: typeof fetch = async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      assertion = body.get('assertion') ?? '';
      return new Response(JSON.stringify({ access_token: 'gcs-token', expires_in: 3600 }), { status: 200 });
    };
    const token = serviceAccountToken(JSON.stringify({ client_email: 'files@project.iam.gserviceaccount.com', private_key: pem }), fetchFn);
    expect(await token()).toBe('gcs-token');
    const verified = await jwtVerify(assertion, await importSPKI(spki, 'RS256'));
    expect(verified.payload.iss).toBe('files@project.iam.gserviceaccount.com');
    expect(verified.payload.scope).toBe('https://www.googleapis.com/auth/devstorage.read_write');
    expect(await token()).toBe('gcs-token');
  });
});

async function readAll(body: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks;
}
