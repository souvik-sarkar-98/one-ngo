import { validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { Tx } from '../../../domain/ports/transaction.js';
import { canEditField, editRefusals, isReadProtected, MASK } from '../../definitions/field-permissions.js';
import type { SaveContext } from './context.js';
import { sameFieldValue } from './scope.js';

/** Refuses keys that are not settable fields and changes the person may not make; a masked value sent back is left unchanged. */
export async function authorize(tx: Tx, s: SaveContext): Promise<void> {
  const { ctx, type, previous, patch } = s;
  const fields = new Map(type.fields.map((f) => [f.key, f]));
  const issues: FieldIssue[] = [];
  for (const k of Object.keys(patch)) {
    const f = fields.get(k);
    if (!f) issues.push({ path: `/${k}`, message: 'is not a field of this record type' });
    else if (f.calculated) issues.push({ path: `/${k}`, message: 'is calculated and cannot be set' });
    else if (f.rollup) issues.push({ path: `/${k}`, message: 'is kept up to date automatically and cannot be set' });
    else if (isReadProtected(type, f) && previous && patch[k] === MASK) delete patch[k];
  }
  if (issues.length) throw validationFailed('Some fields cannot be saved.', issues);
  const refused = editRefusals(
    ctx.actor,
    type,
    Object.keys(patch).filter((k) => !canEditField(ctx.actor, fields.get(k)!) && !sameFieldValue(previous?.[k], patch[k])),
  );
  if (refused.length) throw validationFailed('Some fields cannot be changed by you.', refused);
}
