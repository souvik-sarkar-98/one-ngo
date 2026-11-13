import { validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { SaveContext } from './context.js';
import { evalTest, sameFieldValue, scope } from './scope.js';

/**
 * editableWhen is judged against the record as it is stored now (on create:
 * empty, at the starting status); visibleWhen against the record being saved,
 * and a hidden field keeps its stored value.
 */
export async function conditions(_tx: Tx, s: SaveContext): Promise<void> {
  const { ctx, type, previous, previousStatus, status, move, patch, data } = s;
  const fields = new Map(type.fields.map((f) => [f.key, f]));
  const issues: FieldIssue[] = [];
  const storedScope = scope(ctx, previous ?? {}, previous ? previousStatus : status, previous, previousStatus, move);
  for (const k of Object.keys(patch)) {
    const f = fields.get(k)!;
    if (!f.editableWhen || sameFieldValue(previous?.[k], patch[k])) continue;
    if (!evalTest(f.editableWhen, storedScope, `field ${k}`)) {
      issues.push({ path: `/${k}`, message: 'cannot be changed now' });
    }
  }
  if (issues.length) throw validationFailed('Some fields cannot be changed now.', issues);

  const savingScope = scope(ctx, data, status, previous, previousStatus, move);
  for (const f of type.fields) {
    if (!f.visibleWhen || evalTest(f.visibleWhen, savingScope, `field ${f.key}`)) continue;
    s.hidden.add(f.key);
    if (f.key in patch) {
      if (previous?.[f.key] !== undefined) data[f.key] = previous[f.key];
      else delete data[f.key];
    }
  }
}
