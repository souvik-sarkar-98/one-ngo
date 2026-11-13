import { validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { can } from '../../../domain/permissions.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { UUID, type SaveContext } from './context.js';

/**
 * Fills fields that copy from the record chosen in a reference field. This
 * happens only when the choice changes, so a record keeps the details as
 * they were when they were chosen.
 */
export async function copyFrom(tx: Tx, s: SaveContext): Promise<void> {
  const { ctx, type, data, previous } = s;
  const copies = type.fields.filter((f) => f.copyFrom);
  if (!copies.length) return;
  const issues: FieldIssue[] = [];
  for (const key of new Set(copies.map((f) => f.copyFrom!.reference))) {
    const id = data[key];
    const refType = type.fields.find((f) => f.key === key)?.referenceType;
    if (typeof id !== 'string' || id === previous?.[key] || !refType || !UUID.test(id)) continue;
    if (!can(ctx.actor, `record:${refType}:read`)) {
      issues.push({ path: `/${key}`, message: 'cannot be chosen: you cannot see these records' });
      continue;
    }
    const row = await s.services.store.get(tx, id);
    if (!row || row.type_key !== refType) {
      issues.push({ path: `/${key}`, message: 'was not found' });
      continue;
    }
    const source = s.services.sensitive.open(s.loaded.typeOf(refType), row.data);
    for (const f of copies) {
      if (f.copyFrom!.reference !== key) continue;
      const value = source[f.copyFrom!.field];
      if (value === undefined || value === null || value === '') delete data[f.key];
      else data[f.key] = value;
    }
  }
  if (issues.length) throw validationFailed('Some fields are not valid.', issues);
}
