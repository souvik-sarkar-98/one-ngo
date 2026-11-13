import type { Actor } from '../actor.js';
import type { FieldIssue } from '@onengo/kernel/ports';
import type { FieldDef, RecordTypeDef } from '../definitions/types.js';
import { can } from './permissions.js';

/** What a person without a field's read permission sees instead of its value. */
export const MASK = '***';

/** The permission needed to see a field: its readPermission, else record:<type>:sensitive for sensitive fields. */
export function readPermissionOf(type: Pick<RecordTypeDef, 'key'>, f: FieldDef): string | undefined {
  return f.readPermission ?? (f.sensitive ? `record:${type.key}:sensitive` : undefined);
}

export function canReadField(actor: Actor, type: Pick<RecordTypeDef, 'key'>, f: FieldDef): boolean {
  const p = readPermissionOf(type, f);
  return !p || can(actor, p);
}

export function canEditField(actor: Actor, f: FieldDef): boolean {
  return !f.editPermission || can(actor, f.editPermission);
}

/** True when some people may not see the field. */
export function isReadProtected(type: Pick<RecordTypeDef, 'key'>, f: FieldDef): boolean {
  return readPermissionOf(type, f) !== undefined;
}

/** Values that are ids the database matches on (records, members, files); the file contents live elsewhere. */
const IDENTIFIER_TYPES: ReadonlySet<FieldDef['type']> = new Set(['reference', 'person', 'file', 'signature']);

/** True when the field's values are stored encrypted: sensitive fields, except ids and rollups. */
export function isStoredEncrypted(f: FieldDef): boolean {
  return !!f.sensitive && !f.rollup && !IDENTIFIER_TYPES.has(f.type);
}

/** The data with every field the person may not see replaced by the mask. */
export function maskFor(actor: Actor | null, type: RecordTypeDef, data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const f of type.fields) {
    if (out[f.key] === undefined || !isReadProtected(type, f)) continue;
    if (!actor || !canReadField(actor, type, f)) out[f.key] = MASK;
  }
  return out;
}

/** Issues for fields in `keys` the person may not change. */
export function editRefusals(actor: Actor, type: RecordTypeDef, keys: Iterable<string>): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const k of keys) {
    const f = type.fields.find((x) => x.key === k);
    if (f && !canEditField(actor, f)) issues.push({ path: `/${k}`, message: `you may not change '${f.label}'` });
  }
  return issues;
}
