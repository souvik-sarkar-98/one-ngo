import { validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { FieldDef, RecordTypeDef } from '../../runtime/definitions/types.js';
import { importable } from '../shared/import-cells.js';

export const MAX_TARGETS = 5;
export const MAX_SOURCES = 50;
const TARGET_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * A reference field filled by old id. `column` holds an old id of a record of the field's
 * reference type, loaded by this file or an earlier one. `target` is a record written from the
 * same row by an earlier target of this file.
 */
export type MigrationRef = { column: string } | { target: string };

/** One record type filled from each row of a file. */
export interface MigrationTarget {
  /** Names the target within its file, for references from later targets. */
  key: string;
  type: string;
  /** The column holding the old system's id; a second run finds the record by it. */
  oldId: string;
  /** Field key to the column that fills it. */
  fields: Record<string, string>;
  /** Reference fields filled by old id. */
  refs: Record<string, MigrationRef>;
  /** A required target that fails fails the whole row; an optional one is left out. */
  required: boolean;
}

export interface SourceMapping {
  targets: MigrationTarget[];
}

/** The record types a profile can write, by key. */
export type TypesByKey = ReadonlyMap<string, RecordTypeDef>;

/** Fields a save fills by itself, so a mapping does not have to. */
const filledBySave = (f: FieldDef) => !!(f.calculated || f.rollup || f.copyFrom || f.follow || f.visibleWhen);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The mapping a person sent for a file, checked against the file's columns and the
 * organisation's record types and returned in its stored shape. Throws with every issue found.
 */
export function readMapping(input: unknown, columns: readonly string[], types: TypesByKey): SourceMapping {
  const issues: FieldIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const raw = isObject(input) && Array.isArray(input.targets) ? input.targets : null;
  if (!raw) throw validationFailed('Send the targets of this file.', [{ path: '/targets', message: 'must be a list' }]);
  if (!raw.length) throw validationFailed('Choose at least one record type for this file.', [{ path: '/targets', message: 'must not be empty' }]);
  if (raw.length > MAX_TARGETS) throw validationFailed(`A file can fill at most ${MAX_TARGETS} record types.`, [{ path: '/targets', message: 'has too many entries' }]);

  const has = new Set(columns);
  const targets: MigrationTarget[] = [];
  for (const [i, t] of raw.entries()) {
    const at = `/targets/${i}`;
    if (!isObject(t)) {
      add(at, 'must be an object');
      continue;
    }
    const key = typeof t.key === 'string' ? t.key : '';
    if (!TARGET_KEY.test(key)) add(`${at}/key`, 'must start with a letter and use lowercase letters, digits or _');
    else if (targets.some((x) => x.key === key)) add(`${at}/key`, `'${key}' is used by another target`);
    const typeKey = typeof t.type === 'string' ? t.type : '';
    const type = types.get(typeKey);
    if (!type) {
      add(`${at}/type`, typeKey ? `'${typeKey}' is not a record type` : 'choose a record type');
      continue;
    }
    const oldId = typeof t.oldId === 'string' ? t.oldId : '';
    if (!has.has(oldId)) add(`${at}/oldId`, oldId ? `the file has no column '${oldId}'` : 'choose the column that holds the old id');

    const used = new Map<string, string>();
    const useColumn = (column: string, fieldKey: string, path: string) => {
      if (!has.has(column)) {
        add(path, `the file has no column '${column}'`);
        return;
      }
      const other = used.get(column);
      if (other) add(path, `column '${column}' already fills '${other}'`);
      else used.set(column, fieldKey);
    };

    const fields: Record<string, string> = {};
    for (const [fieldKey, column] of Object.entries(isObject(t.fields) ? t.fields : {})) {
      const path = `${at}/fields/${fieldKey}`;
      const f = type.fields.find((x) => x.key === fieldKey);
      if (!f) add(path, `'${fieldKey}' is not a field of ${type.label}`);
      else if (!importable(f)) add(path, `'${f.label}' cannot be filled from a file`);
      else if (typeof column !== 'string' || !column) add(path, 'choose a column');
      else {
        useColumn(column, f.key, path);
        fields[f.key] = column;
      }
    }

    const refs: Record<string, MigrationRef> = {};
    const tried = new Set([...Object.keys(isObject(t.fields) ? t.fields : {}), ...Object.keys(isObject(t.refs) ? t.refs : {})]);
    for (const [fieldKey, ref] of Object.entries(isObject(t.refs) ? t.refs : {})) {
      const path = `${at}/refs/${fieldKey}`;
      const f = type.fields.find((x) => x.key === fieldKey);
      if (!f || f.type !== 'reference' || !f.referenceType) {
        add(path, `'${fieldKey}' is not a reference field of ${type.label}`);
        continue;
      }
      if (Object.hasOwn(fields, f.key)) {
        add(path, `'${f.label}' is already filled from a column`);
        continue;
      }
      if (isObject(ref) && typeof ref.column === 'string') {
        useColumn(ref.column, f.key, path);
        refs[f.key] = { column: ref.column };
      } else if (isObject(ref) && typeof ref.target === 'string') {
        const earlier = targets.find((x) => x.key === ref.target);
        if (!earlier) add(path, `'${ref.target}' is not an earlier target of this file`);
        else if (earlier.type !== f.referenceType) add(path, `'${ref.target}' writes ${types.get(earlier.type)?.label ?? earlier.type}, not ${types.get(f.referenceType)?.label ?? f.referenceType}`);
        else refs[f.key] = { target: earlier.key };
      } else add(path, 'must name a column or an earlier target');
    }

    for (const f of type.fields) {
      if (!f.required || filledBySave(f) || tried.has(f.key)) continue;
      add(`${at}/fields/${f.key}`, `${type.label} needs '${f.label}'; match a column to it`);
    }
    if (!Object.keys(fields).length && !Object.keys(refs).length) add(`${at}/fields`, 'match at least one column to a field');

    targets.push({ key, type: type.key, oldId, fields, refs, required: t.required !== false });
  }
  if (!issues.length && !targets.some((t) => t.required)) add('/targets', 'at least one target must be required');
  if (issues.length) throw validationFailed('This mapping cannot be saved.', issues);
  return { targets };
}

/** A file of a profile as ordering sees it. */
export interface OrderedSource {
  id: string;
  fileName: string;
  mapping: SourceMapping | null;
}

/** Record types a file writes. */
const writes = (s: OrderedSource) => new Set((s.mapping?.targets ?? []).map((t) => t.type));

/** Record types a file looks up by old id, written by other files. */
function needs(s: OrderedSource, types: TypesByKey): Set<string> {
  const out = new Set<string>();
  for (const t of s.mapping?.targets ?? []) {
    const type = types.get(t.type);
    for (const [fieldKey, ref] of Object.entries(t.refs)) {
      if (!('column' in ref)) continue;
      const refType = type?.fields.find((f) => f.key === fieldKey)?.referenceType;
      if (refType) out.add(refType);
    }
  }
  for (const own of writes(s)) out.delete(own);
  return out;
}

/** For each file, the files that must load before it: those writing a record type it looks up by old id. */
export function dependencies(sources: readonly OrderedSource[], types: TypesByKey): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of sources) {
    const wanted = needs(s, types);
    out.set(
      s.id,
      sources.filter((o) => o.id !== s.id && [...writes(o)].some((t) => wanted.has(t))).map((o) => o.id),
    );
  }
  return out;
}

/**
 * The given order when every file comes after the files it looks up, else why not. A file without
 * a mapping keeps its place and is not run.
 */
export function checkOrder(order: readonly OrderedSource[], types: TypesByKey): void {
  const deps = dependencies(order, types);
  const position = new Map(order.map((s, i) => [s.id, i]));
  const issues: FieldIssue[] = [];
  for (const [i, s] of order.entries()) {
    for (const d of deps.get(s.id) ?? []) {
      if (position.get(d)! > i) {
        const before = order[position.get(d)!]!;
        issues.push({ path: `/order/${i}`, message: `${s.fileName} looks up records from ${before.fileName}, so it must come after it` });
      }
    }
  }
  if (issues.length) throw validationFailed('These files are in an order that cannot run.', issues);
}

/**
 * An order that runs: files keep their current order unless one must wait for another. Throws
 * when two files each look up records the other writes.
 */
export function deriveOrder<S extends OrderedSource>(sources: readonly S[], types: TypesByKey): S[] {
  const deps = dependencies(sources, types);
  const placed = new Set<string>();
  const out: S[] = [];
  while (out.length < sources.length) {
    const next = sources.find((s) => !placed.has(s.id) && (deps.get(s.id) ?? []).every((d) => placed.has(d)));
    if (!next) {
      const stuck = sources.filter((s) => !placed.has(s.id)).map((s) => s.fileName);
      throw validationFailed('These files each look up records the other writes, so neither can load first.', [
        { path: '/order', message: stuck.join(', ') },
      ]);
    }
    placed.add(next.id);
    out.push(next);
  }
  return out;
}
