import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { GcsFileStore, gcsJsonClient, metadataServerToken } from '@onengo/kernel/files';
import { fixtureFetch, tempFixture } from './helpers.js';

const BUCKET = 'demo-bucket';
const PREFIX = 'tenant-files/';
const KEY = 'org-1/2026/abc_123';
const BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))]);

describe('Cloud Storage stand-in', () => {
  it('keeps an upload on disk across a restart, serves the same bytes, and deletes it', async () => {
    const first = await tempFixture();
    const dataDir = first.dataDir;
    try {
      const fetch1 = fixtureFetch(first.fixture);
      const store1 = new GcsFileStore(gcsJsonClient({ bucket: BUCKET, accessToken: metadataServerToken(fetch1), fetch: fetch1 }), PREFIX);
      await store1.put(KEY, Readable.from([BYTES]), 'application/pdf');
      expect(await readFile(join(first.fixture.filesDir, BUCKET, 'tenant-files', 'org-1', '2026', 'abc_123'))).toEqual(BYTES);
      expect(first.fixture.log.list().some((e) => e.area === 'storage' && e.summary.startsWith(`Stored ${BUCKET}/${PREFIX}${KEY}`))).toBe(true);
    } finally {
      await first.fixture.close();
    }

    const second = await tempFixture({ dataDir });
    try {
      const fetch2 = fixtureFetch(second.fixture);
      const store2 = new GcsFileStore(gcsJsonClient({ bucket: BUCKET, accessToken: metadataServerToken(fetch2), fetch: fetch2 }), PREFIX);
      expect(await buffer(await store2.get(KEY))).toEqual(BYTES);
      await store2.delete(KEY);
      await expect(store2.get(KEY)).rejects.toThrow(/not found/i);
      await store2.delete(KEY);
    } finally {
      await second.fixture.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses calls without the metadata token and object names that leave the bucket', async () => {
    const { fixture, cleanup } = await tempFixture();
    try {
      const f = fixtureFetch(fixture);
      expect((await f('https://storage.googleapis.com/storage/v1/b/demo-bucket/o/x?alt=media')).status).toBe(401);
      expect((await f('http://metadata.google.internal/token')).status).toBe(403);
      const auth = { authorization: 'Bearer demo-gcs-token' };
      const escape = await f(`https://storage.googleapis.com/upload/storage/v1/b/demo-bucket/o?uploadType=media&name=${encodeURIComponent('../../outside')}`, { method: 'POST', headers: auth, body: 'x' });
      expect(escape.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});
