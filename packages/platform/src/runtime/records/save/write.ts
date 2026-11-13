import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import { conflict, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { Tx } from '../../../domain/ports/transaction.js';
import { fiscalYearKey, formatNumber, numberingPeriod } from '../../definitions/number-format.js';
import type { FieldDef, RecordTypeDef } from '../../definitions/types.js';
import { kindOfMime } from '../file-kinds.js';
import type { RecordStore } from '../ports/record-store.js';
import { searchText, type RecordRow } from '../query.js';
import { maintainRollups, ownRollups } from '../rollups.js';
import { UUID, type SaveContext } from './context.js';
import { encrypt } from './encrypt.js';
import { startParallel } from './moves.js';
import { logScripts } from './script.js';

/**
 * Inserts the record, or updates it at the expected version, with its files
 * and the rollups that count it; `s.move` becomes where it ends up.
 */
export async function write(tx: Tx, s: SaveContext, expectedVersion: number | null): Promise<RecordRow> {
  const { ctx, loaded, type, current, data } = s;
  const { store } = s.services;
  s.move = { ...s.move, states: startParallel(ctx, loaded, data, s.move, s.previous, !current) };
  let row: RecordRow | undefined;
  if (!current) {
    for (const f of type.fields) if (f.rollup) data[f.key] = 0;
    await logScripts(store, tx, s.scripts, null);
    const number = await allocateNumber(store, tx, type);
    const stored = encrypt(s);
    row = await store.insert(tx, {
      typeKey: type.key,
      schemaVersion: loaded.type.version,
      number,
      status: s.status,
      data: stored.data,
      index: stored.index,
      workflowKey: s.move.workflow,
      states: s.move.states,
      searchText: searchText(type, number, data),
      actorId: ctx.actor.id,
    });
  } else {
    await logScripts(store, tx, s.scripts, current.id);
    await ownRollups(store, tx, loaded, current.id, data, s.services.sensitive);
    const stored = encrypt(s);
    row = await store.update(tx, current.id, expectedVersion!, {
      data: stored.data,
      index: stored.index,
      status: s.status,
      schemaVersion: loaded.type.version,
      states: s.move.states,
      searchText: searchText(type, current.number, data),
      actorId: ctx.actor.id,
    });
    if (!row) throw conflict('This record was changed by someone else. Reload it and try again.');
  }
  row = { ...row, data };
  await s.services.linkFiles(tx, ctx, type, row.id, data);
  await maintainRollups(store, tx, ctx, loaded, current, row, s.services.sensitive);
  return row;
}

async function allocateNumber(store: RecordStore, tx: Tx, type: RecordTypeDef): Promise<string | null> {
  if (!type.numbering) return null;
  const fy = fiscalYearKey(new Date().toISOString().slice(0, 10), await store.fiscalYearStartMonth(tx));
  const period = numberingPeriod(type.numbering.reset, fy);
  const seq = await store.nextSequenceValue(tx, `record:${type.numbering.sequence}`, period);
  return formatNumber(type.numbering.format, { seq, fy, period });
}

/**
 * Links the files held by file and signature fields to the record and field,
 * inside the save transaction, and unlinks files the record no longer holds
 * (the clean-up job removes those later). A newly attached file must exist,
 * be uploaded by the person saving, not be attached elsewhere, and fit the field.
 */
export async function linkRecordFiles(
  store: RecordStore,
  tx: Tx,
  ctx: TenantContext,
  type: RecordTypeDef,
  recordId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const fields = type.fields.filter((f) => f.type === 'file' || f.type === 'signature');
  if (!fields.length) return;
  const issues: FieldIssue[] = [];
  const wanted = new Map<string, FieldDef>();
  for (const f of fields) {
    const v = data[f.key];
    const ids = f.type === 'signature' ? [(v as { file?: unknown } | undefined)?.file] : Array.isArray(v) ? v : [v];
    for (const id of ids) {
      if (typeof id !== 'string' || !UUID.test(id)) continue;
      if (wanted.has(id)) issues.push({ path: `/${f.key}`, message: 'holds a file that is already in another field' });
      else wanted.set(id, f);
    }
  }
  const rows = wanted.size ? await store.files(tx, [...wanted.keys()]) : [];
  const found = new Map(rows.map((r) => [r.id, r]));
  const link = new Map<string, string[]>();
  for (const [id, f] of wanted) {
    const file = found.get(id);
    const path = `/${f.key}`;
    if (file?.record_id === recordId && file.field_key === f.key) continue;
    if (!file || (!file.record_id && file.created_by !== ctx.actor.id)) {
      issues.push({ path, message: 'refers to a file that was not found' });
      continue;
    }
    if (file.record_id) {
      issues.push({ path, message: 'refers to a file that is attached elsewhere' });
      continue;
    }
    if (f.type === 'file') {
      const kind = kindOfMime(file.mime);
      if (f.accept?.length && (!kind || !f.accept.includes(kind))) {
        issues.push({ path, message: `accepts only ${f.accept.join(', ')} files` });
        continue;
      }
      if (f.maxSizeMb && Number(file.size) > f.maxSizeMb * 1024 * 1024) {
        issues.push({ path, message: `accepts files of at most ${f.maxSizeMb} MB` });
        continue;
      }
    }
    link.set(f.key, [...(link.get(f.key) ?? []), id]);
  }
  if (issues.length) throw validationFailed('Some files cannot be attached.', issues);
  await store.unlinkFiles(tx, recordId, fields.map((f) => f.key), [...wanted.keys()]);
  for (const [fieldKey, ids] of link) await store.linkFiles(tx, recordId, fieldKey, ids);
}
