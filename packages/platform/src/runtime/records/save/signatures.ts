import { validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { Tx } from '../../../domain/ports/transaction.js';
import { SIGNATURE_MAX_BYTES } from '../file-kinds.js';
import { UUID, type SaveContext } from './context.js';

/**
 * A new signature must be a stored PNG of at most 200 kB; the server records
 * when and by whom it was signed. Once saved it can only be cleared.
 */
export async function signatures(tx: Tx, s: SaveContext): Promise<void> {
  const { ctx, type, data, previous, patch } = s;
  const issues: FieldIssue[] = [];
  for (const f of type.fields) {
    if (f.type !== 'signature' || !(f.key in patch)) continue;
    const next = data[f.key] as { file?: unknown; signedBy?: unknown } | undefined;
    const prev = previous?.[f.key] as { file?: unknown } | undefined;
    if (next === undefined) continue;
    if (prev && typeof next === 'object' && next.file === prev.file) {
      data[f.key] = prev;
      continue;
    }
    if (prev) {
      issues.push({ path: `/${f.key}`, message: 'is already signed; it can only be cleared' });
      continue;
    }
    if (typeof next !== 'object' || typeof next.file !== 'string' || !UUID.test(next.file)) continue;
    const [file] = await s.services.store.files(tx, [next.file]);
    if (!file || file.mime !== 'image/png' || Number(file.size) > SIGNATURE_MAX_BYTES) {
      issues.push({ path: `/${f.key}`, message: 'must be a signature image of at most 200 kB' });
      continue;
    }
    const signedBy = typeof next.signedBy === 'string' ? next.signedBy.trim().slice(0, 200) : '';
    data[f.key] = { file: next.file, signedAt: new Date().toISOString(), signedBy: signedBy || ((await s.services.store.userName(tx, ctx.actor.id)) ?? ctx.actor.id) };
  }
  if (issues.length) throw validationFailed('Some fields are not valid.', issues);
}
