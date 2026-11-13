import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { GcsClient } from '@onengo/kernel/files';
import { gcsAuditArchiver } from '../src/infrastructure/audit/audit-archive.js';
import { auditArchiveFromEnvironment } from '../src/composition/entry.js';

async function text(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

function fakeBucket() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const client: GcsClient = {
    async upload(object, body, contentType) {
      objects.set(object, { body: await text(body), contentType });
    },
    async download() {
      return null;
    },
    async remove() {},
  };
  return { client, objects };
}

describe('Cloud Storage audit archive', () => {
  it('writes one gzipped JSON-lines object per run, named by tenant and id range', async () => {
    const { client, objects } = fakeBucket();
    await gcsAuditArchiver(client, 'audit-archive/')('tenant-1', [
      { id: '7', action: 'record.created' },
      { id: '9', action: 'record.updated' },
    ]);
    expect([...objects.keys()]).toEqual(['audit-archive/tenant-1/audit-7-9.jsonl.gz']);
    const object = objects.get('audit-archive/tenant-1/audit-7-9.jsonl.gz')!;
    expect(object.contentType).toBe('application/gzip');
    const lines = gunzipSync(object.body).toString().trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { id: '7', action: 'record.created' },
      { id: '9', action: 'record.updated' },
    ]);
  });

  it('writes the same object name when the same rows are archived again, so a retry leaves no duplicate', async () => {
    const { client, objects } = fakeBucket();
    const archive = gcsAuditArchiver(client);
    await archive('t', [{ id: '1' }, { id: '2' }]);
    await archive('t', [{ id: '1' }, { id: '2' }]);
    expect(objects.size).toBe(1);
  });

  it('lets a failed upload reach the caller, which then deletes nothing', async () => {
    const client: GcsClient = {
      async upload() {
        throw new Error('Cloud Storage upload failed with 503');
      },
      async download() {
        return null;
      },
      async remove() {},
    };
    await expect(gcsAuditArchiver(client)('t', [{ id: '1' }])).rejects.toThrow(/503/);
  });
});

describe('audit archive from the environment', () => {
  it('uses the bucket when one is set, and the folder otherwise', () => {
    const token = async () => 'unused';
    expect(auditArchiveFromEnvironment({ AUDIT_ARCHIVE_BUCKET: 'b' }, token).archiveAudit).toBeTypeOf('function');
    expect(auditArchiveFromEnvironment({ AUDIT_ARCHIVE_DIR: 'archive' }, token).archiveAudit).toBeTypeOf('function');
    expect(auditArchiveFromEnvironment({ AUDIT_ARCHIVE_BUCKET: '  ', AUDIT_ARCHIVE_DIR: '' }, token)).toEqual({});
  });
});
