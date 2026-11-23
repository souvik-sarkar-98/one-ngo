import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, createWorld, type TestWorld } from './helpers.js';

const objects = new Map<string, Buffer>();

const storageFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const key = decodeURIComponent(url.pathname);
  const method = init?.method ?? 'GET';
  if (!String(init?.headers && (init.headers as Record<string, string>).authorization).startsWith('AWS4-HMAC-SHA256 ')) {
    return new Response('unsigned', { status: 403 });
  }
  if (method === 'PUT') {
    objects.set(key, Buffer.from(await new Response(init?.body as never).arrayBuffer()));
    return new Response(null, { status: 200 });
  }
  if (method === 'DELETE') {
    objects.delete(key);
    return new Response(null, { status: 204 });
  }
  const found = objects.get(key);
  return found ? new Response(found) : new Response('missing', { status: 404 });
};

const s3 = (key: string, bucket = 'asha') => ({
  kind: 'storage' as const,
  enabled: true,
  config: { provider: 's3', bucket, region: 'us-east-1', endpoint: 'https://s3.test' },
  secrets: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
});

describe('storage connectors', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createWorld({ fileStore: null, storageFetch });
  });
  afterAll(() => w?.close());

  it('refuses an upload until Settings names a storage connector', async () => {
    await expect(w.platform.files.upload(w.as(w.ngoA), { name: 'note.txt', body: [Buffer.from('no store')] })).rejects.toThrow(
      'Choose a file store in Settings before uploading.',
    );
  });

  it('writes store_ref for the chosen connector and still reads the file after the choice changes', async () => {
    await w.platform.connectors.save(w.as(w.ngoA), 'files', s3('files'));
    await w.platform.administration.saveSettings(w.as(w.ngoA), { fileStoreConnector: 'files' });
    const saved = await w.platform.files.upload(w.as(w.ngoA, admin), { name: 'note.txt', body: [Buffer.from('hello storage')] });
    const row = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ store_ref: string }>(`select store_ref from file_object where id = $1`, [saved.id]));
    expect(row[0]?.store_ref).toBe('connector:files');

    await w.platform.connectors.save(w.as(w.ngoA), 'files-b', s3('files-b', 'asha-b'));
    await w.platform.administration.saveSettings(w.as(w.ngoA), { fileStoreConnector: 'files-b' });
    const opened = await w.platform.files.open(w.as(w.ngoA, admin), saved.id);
    expect(Buffer.concat(await readAll(opened.body)).toString('utf8')).toBe('hello storage');
    const next = await w.platform.files.upload(w.as(w.ngoA, admin), { name: 'next.txt', body: [Buffer.from('next')] });
    const nextRow = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ store_ref: string }>(`select store_ref from file_object where id = $1`, [next.id]));
    expect(nextRow[0]?.store_ref).toBe('connector:files-b');
  });

  it('refuses to switch off a store that still holds files or is chosen in Settings', async () => {
    await expect(w.platform.connectors.save(w.as(w.ngoA), 'files', { ...s3('files'), enabled: false })).rejects.toThrow(/still holds files/);
    await expect(w.platform.connectors.save(w.as(w.ngoA), 'files-b', { ...s3('files-b', 'asha-b'), enabled: false })).rejects.toThrow(/Settings uses it/);
  });
});

async function readAll(body: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks;
}
