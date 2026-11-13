import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { GcsClient } from '@onengo/kernel/files';

/** Gzipped JSON lines for a run of audit rows, and the file name that names the id range it holds. */
function archiveOf(rows: Record<string, unknown>[]): { name: string; body: Buffer } {
  const first = String(rows[0]?.id ?? '0');
  const last = String(rows[rows.length - 1]?.id ?? '0');
  return { name: `audit-${first}-${last}.jsonl.gz`, body: gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n') };
}

/**
 * Writes archived audit rows as gzipped JSON lines, one file per NGO per run,
 * under `<dir>/<tenantId>/`. Resolves only after the file is written, so the
 * caller deletes rows only once they are safely on disk.
 */
export function fileAuditArchiver(dir: string) {
  return async (tenantId: string, rows: Record<string, unknown>[]): Promise<void> => {
    const folder = join(dir, tenantId);
    await mkdir(folder, { recursive: true });
    const { name, body } = archiveOf(rows);
    await writeFile(join(folder, name), body, { flag: 'wx' });
  };
}

/**
 * The same files in a Cloud Storage bucket, as `<prefix><tenantId>/audit-<first>-<last>.jsonl.gz`. The upload
 * must succeed (the client throws otherwise) before the caller deletes the rows. A retry of the same rows
 * writes the same object name, so a crash between upload and delete leaves no duplicate.
 */
export function gcsAuditArchiver(client: GcsClient, prefix = '') {
  return async (tenantId: string, rows: Record<string, unknown>[]): Promise<void> => {
    const { name, body } = archiveOf(rows);
    await client.upload(`${prefix}${tenantId}/${name}`, Readable.from(body), 'application/gzip');
  };
}
