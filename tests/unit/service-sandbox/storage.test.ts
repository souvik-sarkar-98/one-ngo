import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORAGE_TOKEN } from '../../../apps/service-sandbox/server/src/constants.js';
import { call, tempFixture } from '../../support/service-sandbox/helpers.js';

const BUCKET = 'demo-bucket';
const OBJECT = 'tenant-files/org-1/2026/abc_123';
const BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256))]);
const auth = { authorization: `Bearer ${STORAGE_TOKEN}` };
const encoded = encodeURIComponent(OBJECT);

describe('Cloud Storage stand-in', () => {
  it('keeps an upload on disk across a restart, serves the same bytes, and deletes it', async () => {
    const first = await tempFixture();
    const dataDir = first.dataDir;
    try {
      const upload = await call(first.fixture, `/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encoded}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/pdf' }, body: BYTES });
      expect(upload.status).toBe(200);
      expect(await readFile(join(first.fixture.filesDir, BUCKET, 'tenant-files', 'org-1', '2026', 'abc_123'))).toEqual(BYTES);
      expect(first.fixture.log.list().some((e) => e.area === 'storage' && e.summary.startsWith(`Stored ${BUCKET}/${OBJECT}`))).toBe(true);
    } finally {
      await first.fixture.close();
    }

    const second = await tempFixture({ dataDir });
    try {
      const downloaded = await call(second.fixture, `/storage/v1/b/${BUCKET}/o/${encoded}?alt=media`, { headers: auth });
      expect(downloaded.status).toBe(200);
      expect(downloaded.body).toEqual(BYTES);
      expect((await call(second.fixture, `/storage/v1/b/${BUCKET}/o/${encoded}`, { method: 'DELETE', headers: auth })).status).toBe(204);
      expect((await call(second.fixture, `/storage/v1/b/${BUCKET}/o/${encoded}?alt=media`, { headers: auth })).status).toBe(404);
      expect((await call(second.fixture, `/storage/v1/b/${BUCKET}/o/${encoded}`, { method: 'DELETE', headers: auth })).status).toBe(404);
    } finally {
      await second.fixture.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses calls without the metadata token and object names that leave the bucket', async () => {
    const { fixture, cleanup } = await tempFixture();
    try {
      expect((await call(fixture, '/storage/v1/b/demo-bucket/o/x?alt=media')).status).toBe(401);
      expect((await call(fixture, '/token')).status).toBe(403);
      const escape = await call(fixture, `/upload/storage/v1/b/demo-bucket/o?uploadType=media&name=${encodeURIComponent('../../outside')}`, { method: 'POST', headers: auth, body: 'x' });
      expect(escape.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});
