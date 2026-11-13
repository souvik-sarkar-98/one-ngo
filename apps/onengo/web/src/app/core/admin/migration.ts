import type { FileDownload, FileHttp } from '../http/http';
import { t } from '../i18n/i18n';
import type { FieldDef, Issue, RecordTypeBody } from '../models';
import { asGatewayError } from '../records/gateway/gateway';
import { Snapshots } from './admin';

export type ProfileStatus = 'draft' | 'checked' | 'running' | 'done' | 'failed';

/** A reference field filled by old id: from a column of old ids, or the record an earlier target of the row wrote. */
export type MigrationRef = { column: string } | { target: string };

export interface MigrationTarget {
  key: string;
  type: string;
  oldId: string;
  fields: Record<string, string>;
  refs: Record<string, MigrationRef>;
  required: boolean;
}

export interface SourceMapping {
  targets: MigrationTarget[];
}

export interface MigrationColumn {
  name: string;
  samples: string[];
}

export interface SourceCounts {
  created: number;
  updated: number;
  failed: number;
}

export interface MigrationSource {
  id: string;
  fileName: string;
  columns: MigrationColumn[];
  rowCount: number;
  position: number;
  mapping: SourceMapping | null;
  counts: SourceCounts | null;
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
  message: string;
}

export interface MigrationCheck {
  rows: number;
  ready: number;
  invalid: number;
  creates: number;
  updates: number;
  sources: { sourceId: string; fileName: string; rows: number; ready: number; invalid: number; creates: number; updates: number }[];
  problems: MigrationProblem[];
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
  createdAt: string;
  updatedAt: string;
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
  return { ...target, fields, refs };
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
}

const POLL_MS = 1500;
const FINISHED = new Set<MigrationJob['status']>(['done', 'failed', 'cancelled']);

/** Data migration screens: the profiles, the open profile, every change to it, and the run's progress while it runs. */
export class MigrationSession {
  readonly state = new Snapshots<MigrationSnapshot>({ list: [], profile: null, job: null, loading: false, busy: false, error: '', issues: [], message: '' });
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
    if (this.state.value.profile?.id !== id) this.state.set({ profile: null, job: null });
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
