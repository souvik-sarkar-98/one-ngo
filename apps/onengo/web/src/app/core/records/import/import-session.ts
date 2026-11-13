import type { FileDownload } from '../../http/http';
import { t } from '../../i18n/i18n';
import type { FieldDef, RecordQueryBody, RuntimeRecordType } from '../../models';
import type { RowView } from '../../rows';
import { asGatewayError } from '../gateway/gateway';
import type { ListSession } from '../list/list-session';
import { LAST_IMPORT_STEP } from '../list/url';

export type ImportStatus = 'uploaded' | 'mapped' | 'checked' | 'running' | 'done' | 'failed';

export interface ImportColumn {
  name: string;
  samples: string[];
}

/** A problem with one row of the file; `row` counts the heading row as 1. */
export interface ImportProblem {
  row: number;
  column?: string;
  field?: string;
  message: string;
}

export interface CheckResult {
  rows: number;
  valid: number;
  invalid: number;
  creates: number;
  updates: number;
  /** The first 200 problems. */
  problems: ImportProblem[];
}

/** Which field each column fills (null: not imported), the unique field that finds records to update, and whether automations stay off. */
export interface ImportMapping {
  columns: Record<string, string | null>;
  updateBy?: string;
  quiet?: boolean;
}

/** An import as the server keeps it. */
export interface ImportView {
  id: string;
  type: string;
  fileName: string;
  columns: ImportColumn[];
  rowCount: number;
  mapping: { columns: Record<string, string | null>; updateBy?: string } | null;
  /** Fields matched to the columns by label or key. */
  suggested: Record<string, string | null>;
  options: { quiet?: boolean };
  status: ImportStatus;
  check: CheckResult | null;
  jobId: string | null;
  counts: { created: number; updated: number; failed: number } | null;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobView {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  total: number | null;
  error: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
}

/** An export small enough comes back as the file; a larger one runs as a job and a notification brings the file. */
export type ExportOutcome = { kind: 'file'; file: FileDownload } | { kind: 'job'; jobId: string };

/** What import and export need from the server. The only implementation that talks HTTP is in http-gateway.ts. */
export interface ImportExportGateway {
  upload(type: string, file: Blob, fileName: string): Promise<ImportView>;
  get(id: string): Promise<ImportView>;
  setMapping(id: string, mapping: ImportMapping): Promise<ImportView>;
  check(id: string): Promise<CheckResult>;
  run(id: string): Promise<ImportView>;
  job(id: string): Promise<JobView>;
  cancelJob(id: string): Promise<JobView>;
  failedRows(id: string): Promise<FileDownload>;
  exportList(type: string, query: RecordQueryBody): Promise<ExportOutcome>;
  exportSelected(type: string, ids: string[]): Promise<ExportOutcome>;
}

/** The stepper's steps, counted from 0 as in the address: upload, match columns, check, run, result. */
export const IMPORT_STEPS = ['ui.imports.stepUpload', 'ui.imports.stepMap', 'ui.imports.stepCheck', 'ui.imports.import', 'ui.imports.stepResult'] as const;
export const RUN_STEP = 3;
export const RESULT_STEP = LAST_IMPORT_STEP;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const POLL_MS = 1500;
const FINISHED = new Set<JobStatus>(['done', 'failed', 'cancelled']);

/** A granted permission covers a required one: `*` as the last part covers the rest, elsewhere one part. */
export function permits(granted: readonly string[], required: string): boolean {
  const r = required.split(':');
  return granted.some((p) => {
    const g = p.split(':');
    for (let i = 0; i < g.length; i++) {
      if (g[i] === '*' && i === g.length - 1) return true;
      if (i >= r.length || (g[i] !== '*' && g[i] !== r[i])) return false;
    }
    return g.length === r.length;
  });
}

/** The list ⋮ entries for import and export, each shown only with its permission. */
export function transferMenu(permissions: readonly string[], type: string): { id: 'import' | 'export'; label: string }[] {
  return [
    ...(permits(permissions, `record:${type}:import`) ? [{ id: 'import' as const, label: t('ui.imports.import') }] : []),
    ...(permits(permissions, `record:${type}:export`) ? [{ id: 'export' as const, label: t('ui.imports.export') }] : []),
  ];
}

export const canImportQuietly = (permissions: readonly string[], type: string) => permits(permissions, `record:${type}:import:quiet`);

type ImportField = FieldDef & { unique?: boolean; rollup?: unknown };

/** Fields a column can fill: not calculated, not kept from other records, not files. */
export function importableFields(type: RuntimeRecordType): FieldDef[] {
  return (type.fields as ImportField[]).filter((f) => !f.calculated && !f.rollup && !['file', 'signature'].includes(f.type));
}

/** Unique fields that some column fills; records whose value matches are updated instead of created. */
export function updateByFields(type: RuntimeRecordType, columns: Record<string, string | null>): FieldDef[] {
  const mapped = new Set(Object.values(columns));
  return (type.fields as ImportField[]).filter((f) => f.unique && mapped.has(f.key));
}

/** One row per column of the file: its examples and the field it fills, or "Not imported" as a badge. */
export function mappingRows(type: RuntimeRecordType, view: ImportView | null, columns: Record<string, string | null>): RowView[] {
  return (view?.columns ?? []).map((c) => {
    const key = columns[c.name];
    const f = key ? type.fields.find((x) => x.key === key) : undefined;
    return {
      id: c.name,
      title: c.name,
      cells: [
        { key: 'samples', label: t('ui.imports.samples'), value: c.samples.join(', ') },
        { key: 'field', label: t('ui.imports.field'), value: f?.label ?? '' },
      ],
      ...(f ? {} : { badge: { label: t('ui.imports.notImported'), tone: 'neutral' as const } }),
      actions: [],
    };
  });
}

/** The step an import can show: as far as it has got, and never back from running or finished. */
export function importStep(view: ImportView | null, asked: number): number {
  if (!view) return 0;
  if (view.status === 'running') return RUN_STEP;
  if (view.status === 'done' || (view.status === 'failed' && view.jobId)) return RESULT_STEP;
  return view.status === 'checked' && view.check ? Math.min(Math.max(asked, 1), 2) : 1;
}

/** Minutes until the job is likely done, from how fast it has gone so far. */
export function minutesLeft(job: JobView, now: number): number | null {
  if (!job.startedAt || !job.total || job.progress <= 0 || job.progress >= job.total) return null;
  const spent = now - Date.parse(job.startedAt);
  return spent > 0 ? Math.max(1, Math.round((spent / job.progress) * (job.total - job.progress) / 60_000)) : null;
}

const cell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** A sample file: the heading row with the label of every field that can be imported. */
export function sampleCsv(type: RuntimeRecordType): { fileName: string; text: string } {
  return { fileName: `${type.pluralLabel ?? type.label}.csv`, text: `\uFEFF${importableFields(type).map((f) => cell(f.label)).join(',')}\r\n` };
}

export interface ImportSnapshot {
  step: number;
  view: ImportView | null;
  /** The file chosen on the upload step, before it is sent. */
  file: { name: string; size: number } | null;
  loading: boolean;
  busy: boolean;
  error: string;
  columns: Record<string, string | null>;
  updateBy: string | null;
  quiet: boolean;
  check: CheckResult | null;
  job: JobView | null;
}

export interface ImportNavigator {
  /** Shows a step of the import (`new` for the upload step); `replace` keeps the current history entry. */
  show(importId: string, step: number, replace: boolean): void;
  close(): void;
}

/** The record list's address bar as the import's navigator. */
export function listImportNavigator(list: () => ListSession): ImportNavigator {
  return {
    show: (importId, step, replace) => (importId === 'new' ? list().openImport() : list().setImport(importId, step, replace)),
    close: () => list().closeImport(),
  };
}

export interface ImportHooks {
  /** The import's job has finished, whatever its outcome. */
  finished?(view: ImportView): void;
  wait?(ms: number): Promise<void>;
}

const EMPTY: ImportSnapshot = { step: 0, view: null, file: null, loading: false, busy: false, error: '', columns: {}, updateBy: null, quiet: false, check: null, job: null };

/**
 * One CSV import into a record list, independent of how it is drawn. The
 * address bar says which import and step are open (`import=new`, then
 * `import=<id>&importStep=n`); the import's own status decides how far it
 * can go, so a reload or a link from the notification lands on the right
 * step. While the job runs its progress is read until it finishes; closing
 * the panel stops reading and leaves the job running.
 */
export class ImportSession {
  private snap: ImportSnapshot = EMPTY;
  private readonly listeners = new Set<(s: ImportSnapshot) => void>();
  private chosen: Blob | null = null;
  private following = 0;
  private watching: { jobId: string } | null = null;

  constructor(
    private readonly gateway: ImportExportGateway,
    private readonly type: RuntimeRecordType,
    private readonly nav: ImportNavigator,
    private readonly hooks: ImportHooks = {},
  ) {}

  get snapshot(): ImportSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: ImportSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** Brings the session in line with the address bar's `import` and `importStep`. */
  async follow(importId: string | undefined, asked = 0): Promise<void> {
    const token = ++this.following;
    if (!importId || importId === 'new') {
      this.watching = null;
      if (!importId || this.snap.view || this.snap.loading || this.snap.step) {
        this.chosen = null;
        this.set(EMPTY);
      }
      return;
    }
    let view = this.snap.view;
    if (view?.id !== importId) {
      this.watching = null;
      this.set({ ...EMPTY, step: asked, loading: true });
      try {
        view = await this.gateway.get(importId);
      } catch (e) {
        if (token === this.following) this.set({ loading: false, error: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
        return;
      }
      if (token !== this.following) return;
      this.adopt(view);
    }
    const step = importStep(view, asked);
    this.set({ step, loading: false });
    if (step !== asked) this.nav.show(view.id, step, true);
    if (step === RUN_STEP && view.jobId) void this.watch(view.jobId);
  }

  /** The file picked or dropped on the upload step. */
  choose(file: Blob, name: string): void {
    this.chosen = file;
    const tooBig = file.size > MAX_IMPORT_BYTES;
    const notCsv = !/\.csv$/i.test(name);
    this.set({ file: { name, size: file.size }, error: notCsv ? t('ui.imports.notCsv') : tooBig ? t('ui.imports.tooBig') : '' });
    if (notCsv || tooBig) this.chosen = null;
  }

  async upload(): Promise<void> {
    const file = this.chosen;
    const name = this.snap.file?.name;
    if (!file || !name) return this.set({ error: this.snap.error || t('ui.imports.notCsv') });
    await this.busy(async () => {
      const view = await this.gateway.upload(this.type.key, file, name);
      this.chosen = null;
      this.adopt(view);
      this.nav.show(view.id, 1, false);
    });
  }

  /** Matches a column to a field (null: not imported). A field fills one column, so another column that had it lets it go. */
  setColumn(column: string, field: string | null): void {
    const columns = { ...this.snap.columns };
    if (field) for (const [c, f] of Object.entries(columns)) if (f === field) columns[c] = null;
    columns[column] = field;
    const updateBy = this.snap.updateBy && Object.values(columns).includes(this.snap.updateBy) ? this.snap.updateBy : null;
    this.set({ columns, updateBy, error: '' });
  }

  setUpdateBy(field: string | null): void {
    this.set({ updateBy: field });
  }

  setQuiet(quiet: boolean): void {
    this.set({ quiet });
  }

  /** Saves the matches and checks every row through the save rules, nothing saved yet. */
  async checkRows(): Promise<void> {
    const id = this.snap.view?.id;
    if (!id) return;
    if (!Object.values(this.snap.columns).some(Boolean)) return this.set({ error: t('ui.imports.matchOne') });
    await this.busy(async () => {
      const view = await this.gateway.setMapping(id, this.mapping());
      const check = await this.gateway.check(id);
      this.set({ view: { ...view, status: 'checked', check }, check });
      this.nav.show(id, 2, false);
    });
  }

  /** Starts the import job and follows its progress. */
  async run(): Promise<void> {
    const before = this.snap.view;
    if (!before) return;
    await this.busy(async () => {
      if (this.snap.quiet !== (before.options.quiet ?? false)) await this.gateway.setMapping(before.id, this.mapping());
      const view = await this.gateway.run(before.id);
      this.set({ view, job: null });
      this.nav.show(view.id, RUN_STEP, false);
    });
  }

  /** Asks the job to stop; rows already saved stay. */
  async cancel(): Promise<void> {
    const jobId = this.snap.view?.jobId;
    if (!jobId) return;
    await this.busy(async () => this.set({ job: await this.gateway.cancelJob(jobId) }));
  }

  back(): void {
    const { step, view } = this.snap;
    if (step <= 1 || !view) this.nav.show('new', 0, false);
    else if (step === 2) this.nav.show(view.id, 1, false);
  }

  close(): void {
    this.nav.close();
  }

  failedRows(): Promise<FileDownload> {
    return this.gateway.failedRows(this.snap.view!.id);
  }

  dispose(): void {
    this.watching = null;
    this.following++;
    this.listeners.clear();
  }

  private mapping(): ImportMapping {
    const { columns, updateBy, quiet } = this.snap;
    return { columns, ...(updateBy ? { updateBy } : {}), ...(quiet ? { quiet } : {}) };
  }

  private adopt(view: ImportView): void {
    this.set({
      view,
      columns: { ...view.suggested, ...view.mapping?.columns },
      updateBy: view.mapping?.updateBy ?? null,
      quiet: view.options.quiet ?? false,
      check: view.check,
      job: null,
      error: '',
    });
  }

  private async watch(jobId: string): Promise<void> {
    if (this.watching?.jobId === jobId) return;
    const me = { jobId };
    this.watching = me;
    const wait = this.hooks.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      while (this.watching === me) {
        const job = await this.gateway.job(jobId);
        if (this.watching !== me) return;
        this.set({ job });
        if (FINISHED.has(job.status)) {
          const view = await this.gateway.get(this.snap.view!.id);
          if (this.watching !== me) return;
          this.watching = null;
          this.adopt(view);
          this.set({ job, step: RESULT_STEP });
          this.hooks.finished?.(view);
          this.nav.show(view.id, RESULT_STEP, true);
          return;
        }
        await wait(POLL_MS);
      }
    } catch (e) {
      if (this.watching === me) {
        this.watching = null;
        this.set({ error: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
      }
    }
  }

  private async busy(work: () => Promise<void>): Promise<void> {
    if (this.snap.busy) return;
    this.set({ busy: true, error: '' });
    try {
      await work();
    } catch (e) {
      this.set({ error: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
    } finally {
      this.set({ busy: false });
    }
  }

  private set(change: Partial<ImportSnapshot>): void {
    this.snap = { ...this.snap, ...change };
    for (const fn of this.listeners) fn(this.snap);
  }
}
