import type { TenantContext } from '../../domain/ports/tenant-context.js';
import type { Tx } from '../../domain/ports/transaction.js';
import type { FieldDef } from '../definitions/types.js';
import type { RecordRow, RecordStore } from './ports/record-store.js';
import type { SensitiveFields } from './sensitive.js';
import { UUID, type Loaded } from './save/context.js';
import { evalTest } from './save/scope.js';

/** Child record data as read, with its sensitive values decrypted. */
export type OpenData = (data: Record<string, unknown>) => Record<string, unknown>;

/** The record's own rollups, recomputed inside the save transaction. */
export async function ownRollups(store: RecordStore, tx: Tx, loaded: Loaded, recordId: string, data: Record<string, unknown>, sensitive: SensitiveFields): Promise<void> {
  for (const f of loaded.type.body.fields) {
    if (f.rollup) data[f.key] = await rollupValue(store, tx, f, recordId, (d) => sensitive.open(loaded.typeOf(f.rollup!.recordType), d));
  }
}

/** Recomputes rollups on the records a child pointed at before and after this save. */
export async function maintainRollups(
  store: RecordStore,
  tx: Tx,
  ctx: TenantContext,
  loaded: Loaded,
  before: RecordRow | null,
  after: RecordRow,
  sensitive: SensitiveFields,
): Promise<void> {
  for (const { type, field } of loaded.rollupParents) {
    const ref = field.rollup!.reference;
    const ids = new Set([before?.data[ref], after.data[ref]].filter((v): v is string => typeof v === 'string' && UUID.test(v)));
    if (ctx.deferredRollups) {
      for (const id of ids) ctx.deferredRollups.add(id);
      continue;
    }
    for (const id of ids) {
      const value = await rollupValue(store, tx, field, id, (d) => sensitive.open(loaded.type.body, d));
      await store.setRollup(tx, type.key, id, field.key, value);
    }
  }
}

export async function rollupValue(store: RecordStore, tx: Tx, field: FieldDef, parentId: string, open: OpenData): Promise<number> {
  const r = field.rollup!;
  const children = await store.children(tx, r.recordType, r.reference, parentId);
  let total = 0;
  for (const c of children) {
    const data = open(c.data);
    if (r.where && !evalTest(r.where, { record: data, status: c.status, previous: {}, previousStatus: null }, `rollup ${field.key}`)) continue;
    if (r.measure === 'count') total++;
    else {
      const n = Number(data[r.field!]);
      if (Number.isFinite(n)) total += n;
    }
  }
  return field.type === 'money' ? Math.round(total * 100) / 100 : total;
}
