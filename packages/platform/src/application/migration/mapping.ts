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

/** A person field filled by legacy user id. */
export interface PersonMapping {
  column: string;
  onMissing?: 'blank' | 'fail';
}

/** A file field filled from a column naming attachments of the profile. */
export interface FileMapping {
  column: string;
  /** Only for a field that holds several files; default `;`. */
  separator?: ';' | ',';
  onMissing?: 'fail' | 'skip';
}

export const FILE_SEPARATORS = [';', ','] as const;

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
  /**
   * Person fields filled from a column of legacy user ids (see `@people`). A blank cell leaves the field
   * blank; an id nothing was loaded for leaves it blank with a warning (`blank`, the default) or fails the row.
   * The column does not count as used, so it may also fill a text field. Missing in older mappings.
   */
  persons?: Record<string, PersonMapping>;
  /**
   * File fields filled from a column of attachment paths (uploaded to the profile). A multiple field splits
   * the cell by `separator` (default `;`). A name no attachment has fails the row (`fail`, the default) or is
   * left out with a warning (`skip`). The column counts as used. Missing in older mappings.
   */
  files?: Record<string, FileMapping>;
  /** A required target that fails fails the whole row; an optional one is left out. */
  required: boolean;
}

/** A file filling record types. Rows stored before people files existed have no kind and are records. */
export interface RecordsMapping {
  kind?: 'records';
  targets: MigrationTarget[];
}

export const ROLE_SEPARATORS = [';', ',', '|'] as const;

/** Which columns of a people file hold what; everything but the first three is optional. */
export interface PeopleSpec {
  /** The legacy system's user id. */
  oldId: string;
  email: string;
  name: string;
  /** Roles from a column (each value may be mapped to an OneNGO role key, or 
ull to ignore it) or the same roles for everyone. */
  roles?: { column: string; separator?: string; map?: Record<string, string | null> } | { fixed: string[] };
  /** Without status everyone is active. Values are compared ignoring case. */
  status?: { column: string; active: string[]; suspended: string[] };
  /** A column of language codes such as en or hi. */
  locale?: string;
}

/** A file whose rows are people of the organisation, not records. */
export interface PeopleMapping {
  kind: 'people';
  people: PeopleSpec;
}

export type SourceMapping = RecordsMapping | PeopleMapping;

/** The pseudo record type a people file writes, for ordering. Type keys start with a letter, so it cannot be one. */
export const PEOPLE_TYPE = '@people';

export const isPeople = (m: SourceMapping | null | undefined): m is PeopleMapping => m?.kind === 'people';
/** The record targets of a mapping; a people file has none. */
export const targetsOf = (m: SourceMapping | null | undefined): MigrationTarget[] => (m && !isPeople(m) ? m.targets : []);

/** The record types a profile can write, by key. */
export type TypesByKey = ReadonlyMap<string, RecordTypeDef>;

/** Fields a save fills by itself, so a mapping does not have to. */
const filledBySave = (f: FieldDef) => !!(f.calculated || f.rollup || f.generated || f.copyFrom || f.follow || f.visibleWhen);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The mapping a person sent for a file, checked against the file's columns and the
 * organisation's record types and returned in its stored shape. Throws with every issue found.
 */
export function readMapping(input: unknown, columns: readonly string[], types: TypesByKey): RecordsMapping {
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

    // Persons: the column is not registered in `used`, so it may also fill a text field.
    const persons: Record<string, PersonMapping> = {};
    for (const [fieldKey, p] of Object.entries(isObject(t.persons) ? t.persons : {})) {
      const path = `${at}/persons/${fieldKey}`;
      const f = type.fields.find((x) => x.key === fieldKey);
      if (!f || f.type !== 'person') {
        add(path, `'${fieldKey}' is not a person field of ${type.label}`);
        continue;
      }
      if (Object.hasOwn(fields, f.key) || Object.hasOwn(refs, f.key) || Object.hasOwn(isObject(t.refs) ? t.refs : {}, f.key)) {
        add(path, `'${f.label}' is already filled from a column`);
        continue;
      }
      tried.add(f.key); // a wrong entry is reported once, not again as "needs"
      const column = isObject(p) && typeof p.column === 'string' ? p.column : '';
      if (!column) add(`${path}/column`, 'choose a column');
      else if (!has.has(column)) add(`${path}/column`, `the file has no column '${column}'`);
      const onMissing = isObject(p) ? p.onMissing : undefined;
      if (onMissing !== undefined && onMissing !== 'blank' && onMissing !== 'fail') add(`${path}/onMissing`, "must be 'blank' or 'fail'");
      if (column && has.has(column) && (onMissing === undefined || onMissing === 'blank' || onMissing === 'fail')) {
        persons[f.key] = { column, ...(onMissing ? { onMissing } : {}) };
      }
    }

    // Files: the column is used; a signature field stays refused.
    const files: Record<string, FileMapping> = {};
    for (const [fieldKey, m] of Object.entries(isObject(t.files) ? t.files : {})) {
      const path = `${at}/files/${fieldKey}`;
      const f = type.fields.find((x) => x.key === fieldKey);
      if (!f || f.type !== 'file') {
        add(path, `'${fieldKey}' is not a file field of ${type.label}`);
        continue;
      }
      tried.add(f.key);
      const column = isObject(m) && typeof m.column === 'string' ? m.column : '';
      const separator = isObject(m) ? m.separator : undefined;
      const onMissing = isObject(m) ? m.onMissing : undefined;
      let good = true;
      if (!column) {
        add(`${path}/column`, 'choose a column');
        good = false;
      } else useColumn(column, f.key, `${path}/column`);
      if (column && !has.has(column)) good = false;
      if (separator !== undefined && !f.multiple) {
        add(`${path}/separator`, `only a field that holds several files has a separator; '${f.label}' holds one`);
        good = false;
      } else if (separator !== undefined && !(FILE_SEPARATORS as readonly unknown[]).includes(separator)) {
        add(`${path}/separator`, `must be one of ${FILE_SEPARATORS.join(' ')}`);
        good = false;
      }
      if (onMissing !== undefined && onMissing !== 'fail' && onMissing !== 'skip') {
        add(`${path}/onMissing`, "must be 'fail' or 'skip'");
        good = false;
      }
      if (good) files[f.key] = { column, ...(separator ? { separator: separator as ';' | ',' } : {}), ...(onMissing ? { onMissing: onMissing as 'fail' | 'skip' } : {}) };
    }

    for (const f of type.fields) {
      if (!f.required || filledBySave(f) || tried.has(f.key)) continue;
      add(`${at}/fields/${f.key}`, `${type.label} needs '${f.label}'; match a column to it`);
    }
    if (!Object.keys(fields).length && !Object.keys(refs).length) add(`${at}/fields`, 'match at least one column to a field');

    targets.push({ key, type: type.key, oldId, fields, refs, ...(Object.keys(persons).length ? { persons } : {}), ...(Object.keys(files).length ? { files } : {}), required: t.required !== false });
  }
  if (!issues.length && !targets.some((t) => t.required)) add('/targets', 'at least one target must be required');
  if (issues.length) throw validationFailed('This mapping cannot be saved.', issues);
  return { targets };
}

/**
 * Reads a mapping of either kind: { kind: 'people', people } is a people file, anything else
 * (no kind, or ecords) is read by {@link readMapping}. oles are the keys of the
 * organisation's roles. Throws with every issue found, with paths such as /people/roles/map/Admin.
 */
export function readSourceMapping(input: unknown, columns: readonly string[], types: TypesByKey, roles: readonly string[]): SourceMapping {
  const kind = isObject(input) ? input.kind : undefined;
  if (kind === undefined || kind === 'records') return readMapping(input, columns, types);
  if (kind !== 'people') throw validationFailed('This mapping cannot be saved.', [{ path: '/kind', message: "must be 'records' or 'people'" }]);
  return readPeopleMapping(input as Record<string, unknown>, columns, roles);
}

const overlaps = (a: readonly string[], b: readonly string[]) => a.some((x) => b.some((y) => x.toLowerCase() === y.toLowerCase()));

function readPeopleMapping(input: Record<string, unknown>, columns: readonly string[], roleKeys: readonly string[]): PeopleMapping {
  const issues: FieldIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const p = input.people;
  if (!isObject(p)) throw validationFailed('Send the columns of this people file.', [{ path: '/people', message: 'must be an object' }]);
  const has = new Set(columns);
  const column = (path: string, value: unknown): string | null => {
    if (typeof value !== 'string' || !value) {
      add(path, 'choose a column');
      return null;
    }
    if (!has.has(value)) {
      add(path, `the file has no column '${value}'`);
      return null;
    }
    return value;
  };
  const used = new Map<string, string>();
  const distinct = (key: 'oldId' | 'email' | 'name', what: string): string => {
    const c = column(`/people/${key}`, p[key]);
    if (c === null) return '';
    const other = used.get(c);
    if (other) add(`/people/${key}`, `column '${c}' already holds ${other}`);
    else used.set(c, what);
    return c;
  };
  const oldId = distinct('oldId', 'the legacy id');
  const email = distinct('email', 'the email');
  const name = distinct('name', 'the name');
  const out: PeopleSpec = { oldId, email, name };

  if (p.roles !== undefined && p.roles !== null) {
    const r = p.roles;
    if (!isObject(r)) add('/people/roles', 'must be an object');
    else if ('fixed' in r && 'column' in r) add('/people/roles', "use either 'column' or 'fixed', not both");
    else if ('fixed' in r) {
      const fixed = Array.isArray(r.fixed) ? r.fixed : null;
      if (!fixed || !fixed.length || fixed.length > 50) add('/people/roles/fixed', 'list 1 to 50 role keys');
      else {
        const keys: string[] = [];
        for (const [i, k] of fixed.entries()) {
          if (typeof k !== 'string' || !roleKeys.includes(k)) add(`/people/roles/fixed/${i}`, typeof k === 'string' && k ? `'${k}' is not a role` : 'choose a role');
          else if (!keys.includes(k)) keys.push(k);
        }
        out.roles = { fixed: keys };
      }
    } else {
      const c = column('/people/roles/column', r.column);
      const separator = r.separator === undefined ? undefined : r.separator;
      if (separator !== undefined && !(ROLE_SEPARATORS as readonly unknown[]).includes(separator)) add('/people/roles/separator', `must be one of ${ROLE_SEPARATORS.join(' ')}`);
      let map: Record<string, string | null> | undefined;
      if (r.map !== undefined && r.map !== null) {
        if (!isObject(r.map)) add('/people/roles/map', 'must be an object');
        else {
          map = {};
          for (const [legacy, target] of Object.entries(r.map)) {
            if (target === null) map[legacy] = null;
            else if (typeof target === 'string' && roleKeys.includes(target)) map[legacy] = target;
            else add(`/people/roles/map/${legacy}`, typeof target === 'string' && target ? `'${target}' is not a role` : 'choose a role, or null to ignore it');
          }
        }
      }
      if (c !== null) out.roles = { column: c, ...(separator ? { separator: separator as string } : {}), ...(map ? { map } : {}) };
    }
  }

  if (p.status !== undefined && p.status !== null) {
    const s = p.status;
    if (!isObject(s)) add('/people/status', 'must be an object');
    else {
      const c = column('/people/status/column', s.column);
      const list = (key: 'active' | 'suspended'): string[] | null => {
        const v = s[key];
        if (!Array.isArray(v) || !v.length || v.length > 100 || v.some((x) => typeof x !== 'string' || !x.trim())) {
          add(`/people/status/${key}`, 'list at least one value');
          return null;
        }
        return [...new Set((v as string[]).map((x) => x.trim()))];
      };
      const active = list('active');
      const suspended = list('suspended');
      if (active && suspended && overlaps(active, suspended)) add('/people/status/suspended', 'a value cannot mean both active and suspended');
      if (c !== null && active && suspended) out.status = { column: c, active, suspended };
    }
  }

  if (p.locale !== undefined && p.locale !== null) {
    const c = column('/people/locale', p.locale);
    if (c !== null) out.locale = c;
  }
  if (issues.length) throw validationFailed('This mapping cannot be saved.', issues);
  return { kind: 'people', people: out };
}

/** A file of a profile as ordering sees it. */
export interface OrderedSource {
  id: string;
  fileName: string;
  mapping: SourceMapping | null;
}

/** Record types a file writes. */
const writes = (s: OrderedSource) => (isPeople(s.mapping) ? new Set([PEOPLE_TYPE]) : new Set(targetsOf(s.mapping).map((t) => t.type)));

/** Record types a file looks up by old id, written by other files. */
function needs(s: OrderedSource, types: TypesByKey): Set<string> {
  const out = new Set<string>();
  for (const t of targetsOf(s.mapping)) {
    const type = types.get(t.type);
    for (const [fieldKey, ref] of Object.entries(t.refs)) {
      if (!('column' in ref)) continue;
      const refType = type?.fields.find((f) => f.key === fieldKey)?.referenceType;
      if (refType) out.add(refType);
    }
    if (Object.keys(t.persons ?? {}).length) out.add(PEOPLE_TYPE);
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
