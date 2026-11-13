import { maskFor } from '../definitions/field-permissions.js';
import type { RecordTypeDef } from '../definitions/types.js';

/**
 * What an audit entry keeps of a record: its status and field values with
 * read-protected fields masked. `diff: true` marks a snapshot that holds only
 * the fields the change touched; without it the snapshot is the whole record
 * (creates, deletes, and entries written before this format).
 */
export interface AuditSnapshot {
  status: string | null;
  data: Record<string, unknown>;
  diff?: true;
}

export interface AuditSide {
  data: Record<string, unknown>;
  status: string | null;
}

const snapshot = (type: RecordTypeDef, data: Record<string, unknown>, status: string | null, diff?: true): AuditSnapshot => ({
  status,
  data: maskFor(null, type, data),
  ...(diff ? { diff } : {}),
});

/**
 * The `before` and `after` of an update, each holding only the fields whose
 * stored value changed. Changed fields are found on the unmasked values, so a
 * masked field that changed is still listed (with the mask as its value). A
 * value that is only re-encoded counts as changed: an entry may list too many
 * fields, never too few. A create has no `before` and keeps the whole record.
 */
export function auditSnapshots(
  type: RecordTypeDef,
  before: AuditSide | null,
  after: AuditSide,
): { before?: AuditSnapshot; after: AuditSnapshot } {
  if (!before) return { after: snapshot(type, after.data, after.status) };
  const keys = new Set([...Object.keys(before.data), ...Object.keys(after.data)]);
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of keys) {
    if (JSON.stringify(before.data[key]) === JSON.stringify(after.data[key])) continue;
    if (key in before.data) b[key] = before.data[key];
    if (key in after.data) a[key] = after.data[key];
  }
  return { before: snapshot(type, b, before.status, true), after: snapshot(type, a, after.status, true) };
}
