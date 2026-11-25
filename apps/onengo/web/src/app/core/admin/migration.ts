import type { FileDownload, FileHttp } from '../http/http';
import { formatNumber, t } from '../i18n/i18n';
import type { FieldDef, Issue, RecordTypeBody } from '../models';
import { asGatewayError } from '../records/gateway/gateway';
import { Snapshots } from './admin';


export type ProfileStatus = 'draft' | 'checked' | 'running' | 'done' | 'failed';

/** A reference field filled by old id: from a column of old ids, or the record an earlier target of the row wrote. */
export type MigrationRef = { column: string } | { target: string };

/** A person field filled from a column of legacy user ids; a blank cell stays blank. */
export interface PersonMapping {
  column: string;
  onMissing?: 'blank' | 'fail';
}

/** A file field filled from a column of attachment paths. `onMissing` defaults to failing the row; `separator` only for several-file fields. */
export interface FileMapping {
  column: string;
  separator?: ';' | ',';
  onMissing?: 'fail' | 'skip';
}

export interface MigrationTarget {
  key: string;
  type: string;
  oldId: string;
  fields: Record<string, string>;
  refs: Record<string, MigrationRef>;
  /** Person fields filled by legacy user id (the people file's old id). Missing in older mappings. */
  persons?: Record<string, PersonMapping>;
  /** File fields filled by attachment path. Missing in older mappings. */
  files?: Record<string, FileMapping>;
  required: boolean;
}

export const ROLE_SEPARATORS = [';', ',', '|'] as const;
export type RoleSeparator = (typeof ROLE_SEPARATORS)[number];

/** Which columns of a people file hold what. Every value is a column name; roles map legacy values to role keys (`null` ignores one). */
export interface PeopleSpec {
  oldId: string;
  email: string;
  name: string;
  roles?: { column: string; separator?: RoleSeparator; map?: Record<string, string | null> } | { fixed: string[] };
  status?: { column: string; active: string[]; suspended: string[] };
  locale?: string;
}

export interface RecordsMapping {
  kind?: 'records';
  targets: MigrationTarget[];
}

export interface PeopleMapping {
  kind: 'people';
  people: PeopleSpec;
}

/** A file's mapping: record targets (older rows have no `kind`) or a people mapping. */
export type SourceMapping = RecordsMapping | PeopleMapping;

export const isPeopleMapping = (m: SourceMapping | null | undefined): m is PeopleMapping => m?.kind === 'people';
/** The record targets of a mapping; a people file has none. */
export const targetsOf = (m: SourceMapping | null | undefined): MigrationTarget[] => (m && !isPeopleMapping(m) ? m.targets : []);

export interface MigrationColumn {
  name: string;
  samples: string[];
}

export interface SourceCounts {
  created: number;
  updated: number;
  failed: number;
  warned?: number;
}

export interface MigrationSource {
  id: string;
  /** 'people' files add members to the organisation; 'records' files fill record types. */
  kind?: 'records' | 'people';
  fileName: string;
  columns: MigrationColumn[];
  rowCount: number;
  position: number;
  mapping: SourceMapping | null;
  counts: SourceCounts | null;
  /** When a purge deleted the file; a purged file is removed and added again before the check or run. */
  purgedAt?: string | null;
}

export interface BooksLine {
  accountCode: string;
  debit?: string;
  credit?: string;
}

export interface BooksInput {
  cutoverDate?: string;
  lines?: BooksLine[];
  receipts?: { series: string; next: number }[];
}

export interface BooksResult {
  journalEntryId?: string;
  receipts?: { series: string; period: string; next: number }[];
  error?: string;
}

export interface MigrationProblem {
  sourceId: string;
  fileName: string;
  row: number;
  column?: string;
  field?: string;
  target?: string;
  /** Absent means `error`. A warning never blocks the run. */
  severity?: 'error' | 'warning';
  message: string;
}

/** Something to know before running that does not block it, grouped by kind and file. */
export interface MigrationWarning {
  kind: string;
  sourceId: string | null;
  fileName: string | null;
  /** The column the warning is about, when it is about one. */
  column?: string;
  count: number;
  samples: string[];
}

export interface MigrationCheck {
  rows: number;
  ready: number;
  invalid: number;
  creates: number;
  updates: number;
  sources: { sourceId: string; fileName: string; rows: number; ready: number; invalid: number; creates: number; updates: number }[];
  problems: MigrationProblem[];
  warnings: MigrationWarning[];
  checkedAt: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  status: ProfileStatus;
  files: number;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationProfile {
  id: string;
  name: string;
  status: ProfileStatus;
  sources: MigrationSource[];
  books: BooksInput;
  booksAppliedAt: string | null;
  booksResult: BooksResult | null;
  check: MigrationCheck | null;
  jobId: string | null;
  /** The attachments uploaded for file fields: how many, and their bytes. */
  attachments?: { count: number; bytes: number };
  /** When the source files, attachments and failed-row data were deleted; null while they are stored. */
  purgedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An attachment as the list shows it; `usedBy` is how many rows name it. */
export interface MigrationAttachment {
  id: string;
  path: string;
  size: number;
  mime: string;
  usedBy: number;
}

export interface AttachmentPage {
  items: MigrationAttachment[];
  total: number;
}

export interface AttachmentQuery {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MigrationJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  total: number | null;
  error: string | null;
  cancelRequested: boolean;
}

/** What the data migration screens need from the server. The only implementation that talks HTTP is `httpMigrationGateway`. */
export interface MigrationGateway {
  list(): Promise<{ items: ProfileSummary[] }>;
  create(name: string): Promise<MigrationProfile>;
  get(id: string): Promise<MigrationProfile>;
  addSource(id: string, file: Blob, fileName: string): Promise<MigrationProfile>;
  removeSource(id: string, sourceId: string): Promise<MigrationProfile>;
  setMapping(id: string, sourceId: string, mapping: SourceMapping): Promise<MigrationProfile>;
  setOrder(id: string, sourceIds: string[]): Promise<MigrationProfile>;
  setBooks(id: string, books: BooksInput): Promise<MigrationProfile>;
  applyBooks(id: string): Promise<MigrationProfile>;
  check(id: string): Promise<MigrationProfile>;
  run(id: string): Promise<MigrationProfile>;
  cancel(id: string): Promise<MigrationProfile>;
  job(jobId: string): Promise<MigrationJob>;
  failedRows(id: string, sourceId: string): Promise<FileDownload>;
  /** Uploads one attachment under its relative path; answers the profile's totals. */
  addAttachment(id: string, file: Blob, path: string): Promise<{ count: number; bytes: number }>;
  attachments(id: string, query?: AttachmentQuery): Promise<AttachmentPage>;
  removeAttachment(id: string, attachmentId: string): Promise<void>;
  clearAttachments(id: string): Promise<void>;
  /** Deletes the source files, attachments, samples and failed-row data; answers the profile. */
  purge(id: string): Promise<MigrationProfile>;
}

export function httpMigrationGateway(http: FileHttp): MigrationGateway {
  const enc = encodeURIComponent;
  const at = (id: string) => `/api/migrations/${enc(id)}`;
  return {
    list: () => http.get('/api/migrations'),
    create: (name) => http.post('/api/migrations', { name }),
    get: (id) => http.get(at(id)),
    addSource: (id, file, fileName) => http.upload(`${at(id)}/sources`, file, fileName),
    removeSource: (id, sourceId) => http.delete(`${at(id)}/sources/${enc(sourceId)}`),
    setMapping: (id, sourceId, mapping) => http.put(`${at(id)}/sources/${enc(sourceId)}/mapping`, mapping),
    setOrder: (id, sourceIds) => http.put(`${at(id)}/order`, { sourceIds }),
    setBooks: (id, books) => http.put(`${at(id)}/books`, books),
    applyBooks: (id) => http.post(`${at(id)}/books/apply`),
    check: (id) => http.post(`${at(id)}/check`),
    run: (id) => http.post(`${at(id)}/run`),
    cancel: (id) => http.post(`${at(id)}/cancel`),
    job: (jobId) => http.get(`/api/jobs/${enc(jobId)}`),
    addAttachment: (id, file, path) => http.upload(`${at(id)}/attachments`, file, path),
    attachments: (id, query = {}) => {
      const qs = new URLSearchParams();
      if (query.q) qs.set('q', query.q);
      if (query.limit) qs.set('limit', String(query.limit));
      if (query.offset) qs.set('offset', String(query.offset));
      return http.get(`${at(id)}/attachments${qs.size ? '?' + qs.toString() : ''}`);
    },
    removeAttachment: (id, attachmentId) => http.delete(`${at(id)}/attachments/${enc(attachmentId)}`),
    clearAttachments: (id) => http.delete(`${at(id)}/attachments`),
    purge: (id) => http.post(`${at(id)}/purge`),
    failedRows: async (id, sourceId) => {
      const answer = await http.download('GET', `${at(id)}/sources/${enc(sourceId)}/failed.csv`);
      if ('json' in answer) throw new Error(t('ui.common.somethingWentWrong'));
      return answer;
    },
  };
}

// ------------------------------------------------------------------ mapping

export const MIGRATION_STEPS = ['files', 'map', 'order', 'books', 'check', 'run'] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];
export const isMigrationStep = (s: string | null | undefined): s is MigrationStep => !!s && (MIGRATION_STEPS as readonly string[]).includes(s);

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Fields a column can fill: not calculated, not kept from other records, not files. */
export const importableFields = (type: RecordTypeBody): FieldDef[] =>
  type.fields.filter((f) => !f.calculated && !f.rollup && f.type !== 'file' && f.type !== 'signature');

/** A key for a new target of a file, unused by the others. */
export function targetKey(type: string, taken: readonly MigrationTarget[]): string {
  const base = (type.replace(/[^a-z0-9_]/gi, '').toLowerCase().replace(/^[^a-z]+/, '') || 'target').slice(0, 30);
  let key = base;
  for (let n = 2; taken.some((x) => x.key === key); n++) key = `${base}_${n}`;
  return key;
}

/**
 * A first guess at how a file fills a record type: each importable field takes the unused column
 * with the same label or key, ignoring case, spaces and punctuation; the old id is the first
 * column named like an id or a code. Reference fields are left for the person to choose.
 */
export function suggestTarget(type: RecordTypeBody, columns: readonly string[], taken: readonly MigrationTarget[] = []): MigrationTarget {
  const used = new Set<string>();
  const fields: Record<string, string> = {};
  for (const f of importableFields(type)) {
    if (f.type === 'reference') continue;
    const column = columns.find((c) => !used.has(c) && squash(c) !== '' && (squash(c) === squash(f.label) || squash(c) === squash(f.key)));
    if (column) {
      fields[f.key] = column;
      used.add(column);
    }
  }
  const oldId = columns.find((c) => /(^|[^a-z])(id|code|no|number)$/i.test(c.trim()) || /id$/i.test(squash(c))) ?? columns[0] ?? '';
  return { key: targetKey(type.key, taken), type: type.key, oldId, fields, refs: {}, required: !taken.some((x) => x.required) };
}

/** The target with one field filled from `column`, or left out when `column` is empty. A column fills one field of a target. */
export function setField(target: MigrationTarget, fieldKey: string, column: string): MigrationTarget {
  const fields = Object.fromEntries(Object.entries(target.fields).filter(([k, c]) => k !== fieldKey && c !== column));
  const refs = Object.fromEntries(Object.entries(target.refs).filter(([k, r]) => k !== fieldKey && !('column' in r && r.column === column)));
  if (column) fields[fieldKey] = column;
  const files = Object.entries(target.files ?? {}).filter(([, f]) => !column || f.column !== column);
  return { ...target, fields, refs, ...(target.files ? { files: Object.fromEntries(files) } : {}) };
}

/** The target with a reference field filled by old id, or left out when `ref` is null. */
export function setRef(target: MigrationTarget, fieldKey: string, ref: MigrationRef | null): MigrationTarget {
  const fields = Object.fromEntries(Object.entries(target.fields).filter(([k, c]) => k !== fieldKey && !(ref && 'column' in ref && c === ref.column)));
  const refs = Object.fromEntries(Object.entries(target.refs).filter(([k]) => k !== fieldKey));
  if (ref) refs[fieldKey] = ref;
  return { ...target, fields, refs };
}

/** The value a reference field's choice holds: `column:<name>`, `target:<key>`, or empty. */
export const refChoice = (ref: MigrationRef | undefined): string => (!ref ? '' : 'column' in ref ? `column:${ref.column}` : `target:${ref.target}`);

export const refOf = (choice: string): MigrationRef | null =>
  choice.startsWith('column:') ? { column: choice.slice(7) } : choice.startsWith('target:') ? { target: choice.slice(7) } : null;

/** The target with a person field filled from a column of legacy user ids, or left out when `column` is empty. */
export function setPerson(target: MigrationTarget, fieldKey: string, column: string, onMissing?: 'blank' | 'fail'): MigrationTarget {
  const persons = Object.fromEntries(Object.entries(target.persons ?? {}).filter(([k]) => k !== fieldKey));
  if (column) persons[fieldKey] = { column, ...(onMissing && onMissing !== 'blank' ? { onMissing } : {}) };
  return { ...target, persons };
}

/** The file fields of a type a column of attachment paths can fill. */
export const fileFields = (type: RecordTypeBody): FieldDef[] => type.fields.filter((f) => f.type === 'file' && !f.calculated && !f.rollup);

/**
 * The target with a file field filled from a column of attachment paths, or left out when `column` is
 * empty. A column fills one field, so it leaves any other field or reference; the separator is kept
 * only for several-file fields, and "fail the row" is the default so it is not written.
 */
export function setFile(target: MigrationTarget, field: FieldDef, column: string, opts: { separator?: ';' | ','; onMissing?: 'fail' | 'skip' } = {}): MigrationTarget {
  const files = Object.fromEntries(Object.entries(target.files ?? {}).filter(([k, f]) => k !== field.key && (!column || f.column !== column)));
  const fields = Object.fromEntries(Object.entries(target.fields).filter(([, c]) => !column || c !== column));
  const refs = Object.fromEntries(Object.entries(target.refs).filter(([, r]) => !column || !('column' in r && r.column === column)));
  if (column) {
    files[field.key] = {
      column,
      ...(field.multiple && opts.separator && opts.separator !== ';' ? { separator: opts.separator } : {}),
      ...(opts.onMissing === 'skip' ? { onMissing: 'skip' as const } : {}),
    };
  }
  return { ...target, fields, refs, files };
}

/** A size for the attachment list: bytes, kB, MB or GB, one decimal from MB up. */
export function byteText(bytes: number): string {
  const one = (n: number) => formatNumber(Math.round(n * 10) / 10);
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes < 1024 ** 2) return `${formatNumber(Math.round(bytes / 1024))} kB`;
  return bytes < 1024 ** 3 ? `${one(bytes / 1024 ** 2)} MB` : `${one(bytes / 1024 ** 3)} GB`;
}

/** The most attachments one migration holds (the server refuses the next). */
export const ATTACHMENT_LIMIT = 5000;
/** The most characters of an attachment path. */
export const ATTACHMENT_PATH_MAX = 255;

/** An attachment path as the server keeps it: forward slashes, no leading slash. */
export const attachmentPath = (raw: string): string => raw.replace(/\\/g, '/').replace(/^\/+/, '');

/** Why a path cannot be uploaded (a catalogue key), or null. The server checks the same rules. */
export function attachmentPathProblem(path: string): string | null {
  if (!path) return 'ui.admin.migration.attach.pathEmpty';
  if (path.length > ATTACHMENT_PATH_MAX) return 'ui.admin.migration.attach.pathLong';
  if (path.split('/').includes('..')) return 'ui.admin.migration.attach.pathDots';
  return null;
}

/** Which of the files can still be added: those with a usable path, up to the room left. The others come back refused with their reason. */
export function planAttachments(files: readonly { body: Blob; name: string }[], held: number): { ok: { body: Blob; name: string }[]; refused: { name: string; message: string }[] } {
  const ok: { body: Blob; name: string }[] = [];
  const refused: { name: string; message: string }[] = [];
  for (const f of files) {
    const name = attachmentPath(f.name);
    const bad = attachmentPathProblem(name);
    if (bad) refused.push({ name: f.name, message: t(bad) });
    else if (held + ok.length >= ATTACHMENT_LIMIT) refused.push({ name, message: t('ui.admin.migration.attach.tooMany', { limit: ATTACHMENT_LIMIT }) });
    else ok.push({ body: f.body, name });
  }
  return { ok, refused };
}

// ------------------------------------------------------------------ people

export interface KindOption {
  kind: 'records' | 'people';
  label: string;
  /** The catalogue key of the line under the label: what it is, or why it is disabled. */
  hint: string;
  disabled: boolean;
}

/** The answers to "What is in this file?". People needs the session flag `migrationPeople` (Migrate people and Manage people). */
export const kindOptions = (peopleAllowed: boolean): KindOption[] => [
  { kind: 'records', label: 'ui.admin.migration.kindRecords', hint: 'ui.admin.migration.kindRecordsHint', disabled: false },
  { kind: 'people', label: 'ui.admin.migration.kindPeople', hint: peopleAllowed ? 'ui.admin.migration.kindPeopleHint' : 'ui.admin.migration.kindPeopleDenied', disabled: !peopleAllowed },
];

/** A people mapping as the form edits it: text and choices only. */
export interface PeopleDraft {
  oldId: string;
  email: string;
  name: string;
  rolesColumn: string;
  separator: RoleSeparator;
  /** Legacy role value to role key; empty means ignore. */
  roleMap: Record<string, string>;
  /** Roles given to everyone (kept as saved; the form does not edit them). */
  fixed: string[];
  statusColumn: string;
  /** Comma separated legacy values. */
  active: string;
  suspended: string;
  locale: string;
}

/** A role a legacy value may become. */
export interface RoleChoice {
  key: string;
  label: string;
  requireTwoStep?: boolean;
}

export interface RoleRow {
  value: string;
  /** The role key, or empty for Ignore. */
  role: string;
}

/** A first guess at which column holds what in a people file, by the column's name. */
export function emptyPeople(columns: readonly string[]): PeopleDraft {
  const find = (re: RegExp, taken: string[]) => columns.find((c) => !taken.includes(c) && re.test(c)) ?? '';
  const oldId = find(/(^|[^a-z])(id|code|no|number)$|id$/i, []);
  const email = find(/e-?mail/i, [oldId]);
  const name = find(/name/i, [oldId, email]);
  const rolesColumn = find(/roles?|group|permission/i, [oldId, email, name]);
  const statusColumn = find(/status|active|enabled/i, [oldId, email, name, rolesColumn]);
  const locale = find(/lang|locale/i, [oldId, email, name, rolesColumn, statusColumn]);
  return { oldId, email, name, rolesColumn, separator: ';', roleMap: {}, fixed: [], statusColumn, active: '', suspended: '', locale };
}

export const listOf = (text: string): string[] => [...new Set(text.split(',').map((v) => v.trim()).filter(Boolean))];

/** The form's view of a saved people mapping. */
export function peopleDraftOf(spec: PeopleSpec): PeopleDraft {
  const roles = spec.roles;
  const column = roles && 'column' in roles ? roles : null;
  return {
    oldId: spec.oldId,
    email: spec.email,
    name: spec.name,
    rolesColumn: column?.column ?? '',
    separator: column?.separator ?? ';',
    roleMap: Object.fromEntries(Object.entries(column?.map ?? {}).map(([k, v]) => [k, v ?? ''])),
    fixed: roles && 'fixed' in roles ? [...roles.fixed] : [],
    statusColumn: spec.status?.column ?? '',
    active: spec.status?.active.join(', ') ?? '',
    suspended: spec.status?.suspended.join(', ') ?? '',
    locale: spec.locale ?? '',
  };
}

/** The mapping to save: only the parts that have a column, with every row of the role table in `map`. */
export function peopleSpecOf(d: PeopleDraft, rows: readonly RoleRow[]): PeopleSpec {
  const spec: PeopleSpec = { oldId: d.oldId, email: d.email, name: d.name };
  if (d.rolesColumn) spec.roles = { column: d.rolesColumn, separator: d.separator, map: Object.fromEntries(rows.map((r) => [r.value, r.role || null])) };
  else if (d.fixed.length) spec.roles = { fixed: [...d.fixed] };
  if (d.statusColumn) spec.status = { column: d.statusColumn, active: listOf(d.active), suspended: listOf(d.suspended) };
  if (d.locale) spec.locale = d.locale;
  return spec;
}

/**
 * The distinct legacy role values the file's samples show for the roles column. The server keeps
 * only the first few values of a column, so this is a start; the form lets people add the rest.
 */
export function legacyRoleValues(samples: readonly string[], separator: RoleSeparator): string[] {
  const seen = new Map<string, string>();
  for (const cell of samples) {
    for (const part of cell.split(separator)) {
      const v = part.trim();
      if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
    }
  }
  return [...seen.values()];
}

/** The existing role a legacy value most likely means: the same key or label ignoring case and punctuation. A role that needs two-step is never guessed. */
export function guessRole(value: string, roles: readonly RoleChoice[]): string {
  const v = squash(value);
  return (v && roles.find((r) => !r.requireTwoStep && (squash(r.key) === v || squash(r.label) === v))?.key) || '';
}

/** The role table: each value found in the sample, then each one added or saved, with the role it becomes (a guess until chosen). */
export function roleRows(values: readonly string[], map: Readonly<Record<string, string>>, roles: readonly RoleChoice[]): RoleRow[] {
  const all = [...values];
  for (const k of Object.keys(map)) if (!all.some((v) => v.toLowerCase() === k.toLowerCase())) all.push(k);
  return all.map((value) => ({ value, role: value in map ? map[value]! : guessRole(value, roles) }));
}

/** A kind of check warning as a title key, for the kinds the server names; any other kind falls under "other". */
const WARNING_KINDS: Record<string, string> = {
  'unresolved-legacy-users': 'unresolvedLegacyUsers',
  'already-members': 'alreadyMembers',
  'duplicate-email': 'duplicateEmail',
  'roles-skipped-suspended': 'rolesSkippedSuspended',
  'script-effects-suppressed': 'scriptEffectsSuppressed',
  'missing-attachments': 'missingAttachments',
  'storage-over-quota': 'storageOverQuota',
};
/** Warnings whose samples are ids or names, so "and n more" is true; for the others a sample is a sentence. */
const ID_SAMPLES = new Set(['unresolved-legacy-users', 'missing-attachments']);

export interface WarningGroup {
  kind: string;
  /** The catalogue key of the group's heading. */
  title: string;
  items: (MigrationWarning & { more: number })[];
}

/** The check's warnings grouped by kind, in the order the server gave them. */
export function groupWarnings(warnings: readonly MigrationWarning[]): WarningGroup[] {
  const groups: WarningGroup[] = [];
  for (const w of warnings) {
    let g = groups.find((x) => x.kind === w.kind);
    if (!g) groups.push((g = { kind: w.kind, title: `ui.admin.migration.warningGroup.${WARNING_KINDS[w.kind] ?? 'other'}`, items: [] }));
    g.items.push({ ...w, more: ID_SAMPLES.has(w.kind) ? Math.max(0, w.count - w.samples.length) : 0 });
  }
  return groups;
}

export interface KindSummary {
  kind: 'records' | 'people';
  files: number;
  rows: number;
  ready: number;
  invalid: number;
  creates: number;
  updates: number;
}

/** The check's per-file figures added up per kind of file, people first. */
export function checkByKind(check: MigrationCheck, sources: readonly MigrationSource[]): KindSummary[] {
  const out = new Map<'records' | 'people', KindSummary>();
  for (const x of check.sources) {
    const kind = sources.find((s) => s.id === x.sourceId)?.kind === 'people' ? 'people' : 'records';
    const k = out.get(kind) ?? { kind, files: 0, rows: 0, ready: 0, invalid: 0, creates: 0, updates: 0 };
    k.files++;
    k.rows += x.rows;
    k.ready += x.ready;
    k.invalid += x.invalid;
    k.creates += x.creates;
    k.updates += x.updates;
    out.set(kind, k);
  }
  return [...out.values()].sort((a, b) => (a.kind === 'people' ? -1 : 1) - (b.kind === 'people' ? -1 : 1));
}

/** Files in a new order, one moved up or down. */
export function moved(sources: readonly MigrationSource[], sourceId: string, by: -1 | 1): string[] {
  const ids = sources.map((s) => s.id);
  const i = ids.indexOf(sourceId);
  const j = i + by;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return ids;
}

/** A balanced opening journal: debits equal credits, in paise. */
export function booksBalance(lines: readonly BooksLine[]): { debit: number; credit: number; balanced: boolean } {
  const paise = (v: string | undefined) => Math.round(Number((v ?? '').replace(/,/g, '') || 0) * 100);
  const debit = lines.reduce((n, l) => n + paise(l.debit), 0);
  const credit = lines.reduce((n, l) => n + paise(l.credit), 0);
  return { debit, credit, balanced: debit === credit };
}

// ------------------------------------------------------------------ session

export interface MigrationSnapshot {
  list: ProfileSummary[];
  profile: MigrationProfile | null;
  job: MigrationJob | null;
  loading: boolean;
  busy: boolean;
  error: string;
  issues: Issue[];
  /** The last change that worked, for the notice. */
  message: string;
  /** The page of attachments the Files step shows; null until read. */
  attachmentList: AttachmentPage | null;
  /** Attachments sent so far in the batch being uploaded; null when none is. */
  upload: { done: number; total: number } | null;
  /** Attachments the last batch could not add, each with the reason. */
  refused: { name: string; message: string }[];
}

const POLL_MS = 1500;
const FINISHED = new Set<MigrationJob['status']>(['done', 'failed', 'cancelled']);

/** Data migration screens: the profiles, the open profile, every change to it, and the run's progress while it runs. */
export class MigrationSession {
  readonly state = new Snapshots<MigrationSnapshot>({ list: [], profile: null, job: null, loading: false, busy: false, error: '', issues: [], message: '', attachmentList: null, upload: null, refused: [] });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly gateway: MigrationGateway,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms),
  ) {}

  async loadList(): Promise<void> {
    this.state.set({ loading: true, error: '' });
    try {
      this.state.set({ list: (await this.gateway.list()).items, loading: false });
    } catch (e) {
      this.state.set({ loading: false, error: asGatewayError(e, t('ui.common.loadFailed')).message });
    }
  }

  async create(name: string): Promise<string | null> {
    const profile = await this.change(() => this.gateway.create(name.trim()), '');
    return profile?.id ?? null;
  }

  async open(id: string): Promise<void> {
    if (this.state.value.profile?.id !== id) this.state.set({ profile: null, job: null, attachmentList: null, refused: [] });
    this.state.set({ loading: true, error: '', issues: [] });
    try {
      const profile = await this.gateway.get(id);
      this.state.set({ profile, loading: false });
      this.follow(profile);
    } catch (e) {
      this.state.set({ loading: false, error: asGatewayError(e, t('ui.common.loadFailed')).message });
    }
  }

  /** Adds the files one after another; a file that is refused does not stop the rest. */
  async addFiles(files: readonly { body: Blob; name: string }[]): Promise<void> {
    const id = this.state.value.profile?.id;
    if (!id) return;
    const refused: string[] = [];
    this.state.set({ busy: true, error: '', issues: [], message: '' });
    for (const f of files) {
      try {
        this.state.set({ profile: await this.gateway.addSource(id, f.body, f.name) });
      } catch (e) {
        refused.push(`${f.name}: ${asGatewayError(e, t('ui.common.somethingWentWrong')).message}`);
      }
    }
    this.state.set({ busy: false, error: refused.join(' '), message: refused.length ? '' : t('ui.admin.migration.filesAdded', { count: files.length }) });
  }

  /**
   * Adds attachments one after another, each under its relative path; one that is refused (by the
   * checks here or by the server) is listed and the rest go on. The profile and the list are read again at the end.
   */
  async addAttachments(files: readonly { body: Blob; name: string }[]): Promise<void> {
    const id = this.state.value.profile?.id;
    if (!id || !files.length) return;
    const { ok, refused } = planAttachments(files, this.state.value.profile?.attachments?.count ?? 0);
    this.state.set({ busy: true, error: '', issues: [], message: '', refused: [...refused], upload: { done: 0, total: ok.length } });
    let added = 0;
    let sent = 0;
    for (const f of ok) {
      try {
        await this.gateway.addAttachment(id, f.body, f.name);
        added++;
      } catch (e) {
        refused.push({ name: f.name, message: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
      }
      this.state.set({ upload: { done: ++sent, total: ok.length }, refused: [...refused] });
    }
    this.state.set({ upload: null });
    await this.reload(id, added ? t('ui.admin.migration.attach.added', { count: added }) : '');
  }

  /** Reads one page of the attachments; `q` is a part of the path. */
  async loadAttachments(query: AttachmentQuery = {}): Promise<void> {
    const id = this.state.value.profile?.id;
    if (!id) return;
    try {
      this.state.set({ attachmentList: await this.gateway.attachments(id, query) });
    } catch (e) {
      this.state.set({ error: asGatewayError(e, t('ui.common.loadFailed')).message });
    }
  }

  removeAttachment(attachmentId: string): Promise<unknown> {
    return this.afterAttachments(() => this.gateway.removeAttachment(this.state.value.profile!.id, attachmentId), t('ui.admin.migration.attach.removed'));
  }

  clearAttachments(): Promise<unknown> {
    return this.afterAttachments(() => this.gateway.clearAttachments(this.state.value.profile!.id), t('ui.admin.migration.attach.cleared'));
  }

  /** Deletes the source files, attachments and failed-row data. */
  async purge(): Promise<void> {
    if (await this.withProfile((id) => this.gateway.purge(id), t('ui.admin.migration.purged'))) await this.loadAttachments();
  }

  removeSource(sourceId: string): Promise<unknown> {
    return this.withProfile((id) => this.gateway.removeSource(id, sourceId), t('ui.admin.migration.fileRemoved'));
  }

  saveMapping(sourceId: string, mapping: SourceMapping): Promise<unknown> {
    return this.withProfile((id) => this.gateway.setMapping(id, sourceId, mapping), t('ui.admin.migration.mappingSaved'));
  }

  move(sourceId: string, by: -1 | 1): Promise<unknown> {
    const p = this.state.value.profile;
    if (!p) return Promise.resolve(null);
    return this.withProfile((id) => this.gateway.setOrder(id, moved(p.sources, sourceId, by)), '');
  }

  saveBooks(books: BooksInput): Promise<unknown> {
    return this.withProfile((id) => this.gateway.setBooks(id, books), t('ui.admin.migration.booksSaved'));
  }

  applyBooks(): Promise<unknown> {
    return this.withProfile((id) => this.gateway.applyBooks(id), t('ui.admin.migration.booksApplied'));
  }

  check(): Promise<unknown> {
    return this.withProfile((id) => this.gateway.check(id), '');
  }

  async run(): Promise<void> {
    const profile = await this.withProfile((id) => this.gateway.run(id), '');
    if (profile) this.follow(profile);
  }

  cancel(): Promise<unknown> {
    return this.withProfile((id) => this.gateway.cancel(id), t('ui.admin.migration.cancelRequested'));
  }

  failedRows(sourceId: string): Promise<FileDownload> {
    return this.gateway.failedRows(this.state.value.profile!.id, sourceId);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** While the profile runs, reads the job and the profile again until the job ends. */
  private follow(profile: MigrationProfile): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (profile.status !== 'running' || !profile.jobId || this.disposed) return;
    const jobId = profile.jobId;
    const tick = async () => {
      this.timer = null;
      if (this.disposed || this.state.value.profile?.id !== profile.id) return;
      try {
        const job = await this.gateway.job(jobId);
        this.state.set({ job });
        if (FINISHED.has(job.status)) {
          const latest = await this.gateway.get(profile.id);
          this.state.set({ profile: latest });
          return;
        }
      } catch {
        // A failed read keeps polling; the next one shows the progress.
      }
      if (!this.disposed) this.timer = this.schedule(() => void tick(), POLL_MS);
    };
    this.timer = this.schedule(() => void tick(), 0);
  }

  /** Reads the profile (its totals and status changed) and the first page of attachments again. */
  private async reload(id: string, message: string): Promise<void> {
    try {
      this.state.set({ profile: await this.gateway.get(id), busy: false, message });
    } catch (e) {
      this.state.set({ busy: false, error: asGatewayError(e, t('ui.common.loadFailed')).message });
    }
    await this.loadAttachments();
  }

  private async afterAttachments(fn: () => Promise<void>, message: string): Promise<void> {
    const id = this.state.value.profile?.id;
    if (!id) return;
    this.state.set({ busy: true, error: '', issues: [], message: '', refused: [] });
    try {
      await fn();
    } catch (e) {
      this.state.set({ busy: false, error: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
      return;
    }
    await this.reload(id, message);
  }

  private withProfile(fn: (id: string) => Promise<MigrationProfile>, message: string): Promise<MigrationProfile | null> {
    const id = this.state.value.profile?.id;
    if (!id) return Promise.resolve(null);
    return this.change(() => fn(id), message);
  }

  private async change(fn: () => Promise<MigrationProfile>, message: string): Promise<MigrationProfile | null> {
    this.state.set({ busy: true, error: '', issues: [], message: '' });
    try {
      const profile = await fn();
      this.state.set({ profile, busy: false, message });
      return profile;
    } catch (e) {
      const err = asGatewayError(e, t('ui.common.somethingWentWrong'));
      this.state.set({ busy: false, error: err.message, issues: err.issues ?? [] });
      return null;
    }
  }
}
