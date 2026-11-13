import { validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { can } from '../../../domain/permissions.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import { UUID, type SaveContext } from './context.js';

/**
 * Fills fields that follow a source when the link on this record is set or
 * changed. Later changes to the source are written by the follow handler.
 */
export async function follow(tx: Tx, s: SaveContext): Promise<void> {
  const { ctx, type, data, previous } = s;
  const follows = type.fields.filter((f) => f.follow);
  if (!follows.length) return;
  const issues: FieldIssue[] = [];
  for (const key of new Set(follows.map((f) => f.follow!.via))) {
    const id = data[key];
    const via = type.fields.find((f) => f.key === key);
    if (typeof id !== 'string' || id === previous?.[key] || !via || !UUID.test(id)) continue;
    if (via.type === 'reference') {
      const refType = via.referenceType;
      if (!refType) continue;
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
      for (const f of follows) {
        if (f.follow!.via !== key) continue;
        assign(data, f.key, source[f.follow!.field]);
      }
    } else if (via.type === 'person') {
      const account = (await s.services.people.identities(tx, [id])).get(id);
      for (const f of follows) {
        if (f.follow!.via !== key) continue;
        const source = f.follow!.field;
        const value = source === 'id' ? id : source === 'name' ? account?.name : source === 'email' ? account?.email : undefined;
        assign(data, f.key, value);
      }
    }
  }
  if (issues.length) throw validationFailed('Some fields are not valid.', issues);
}

function assign(data: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') delete data[key];
  else data[key] = value;
}
