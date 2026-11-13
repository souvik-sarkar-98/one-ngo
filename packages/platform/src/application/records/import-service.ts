import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { conflict, notFound, PlatformError, validationFailed } from '@onengo/kernel/errors';
import type { JobItemResult, JobRun, JobBatch, JobRunner, JobView } from '../../runtime/records/ports/job-runner.js';
import { demand } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import type { RecordTypeDef } from '../../runtime/definitions/types.js';
import type { FileService, UploadInput } from '../files/file-service.js';
import { csvTable, importable, parseCell, parseDate, parseNumber, problemsOf, readCell, suggestMapping, type CsvRow } from '../shared/import-cells.js';
import { cleanFileName } from '../shared/file-name.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { CsvCodec } from './ports/csv-codec.js';
import type { ImportRow, ImportStore } from './ports/import-store.js';

const MB = 1024 * 1024;
export const IMPORT_MAX_BYTES = 10 * MB;
export const IMPORT_MAX_ROWS = 20_000;
const PROBLEMS_SHOWN = 200;
const SAMPLES = 3;
const ROLLUPS_PER_BATCH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ImportStatus = 'uploaded' | 'mapped' | 'checked' | 'running' | 'done' | 'failed';

export interface ImportColumn {
  name: string;
  samples: string[];
}

/** Which field each column fills (null: not imported), and the unique field that finds records to update. */
export interface ImportMapping {
  columns: Record<string, string | null>;
  updateBy?: string;
}

export interface ImportOptions {
  /** Automations do not run for the imported records; needs `record:<type>:import:quiet`. */
  quiet?: boolean;
}

export interface ImportProblem {
  /** The row in the file, counting the heading row as 1. */
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

export interface ImportView {
  id: string;
  type: string;
  fileId: string;
  fileName: string;
  columns: ImportColumn[];
  rowCount: number;
  mapping: ImportMapping | null;
  /** Fields matched to the columns by label or key. */
  suggested: Record<string, string | null>;
  options: ImportOptions;
  status: ImportStatus;
  check: CheckResult | null;
  jobId: string | null;
  counts: { created: number; updated: number; failed: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface MappingInput {
  columns?: Record<string, unknown>;
  updateBy?: unknown;
  quiet?: unknown;
}

type DataRow = CsvRow;

interface ImportState {
  next?: number;
  created?: number;
  updated?: number;
  failed?: number;
  parents?: string[];
}

const iso = (v: string | Date) => new Date(v).toISOString();

export { importable, parseCell, parseDate, parseNumber, suggestMapping };

const reasonOf = (problems: ImportProblem[]) => problems.map((p) => p.message).join('; ');

/**
 * CSV imports: the file is stored, its columns are matched to fields, every
 * row can be checked through the record engine without saving, and a job
 * saves the rows through the normal pipeline.
 */
export class ImportService {
  private readonly parsed = new Map<string, { header: string[]; rows: DataRow[] }>();

  constructor(
    private readonly tm: TransactionManager,
    private readonly store: ImportStore,
    private readonly defs: DefinitionReader,
    private readonly records: RecordService,
    private readonly files: FileService,
    private readonly jobs: JobRunner,
    private readonly csv: CsvCodec,
  ) {
    jobs.register<{ importId: string; recordType?: string }, ImportState>('import', {
      label: 'Import',
      exclusive: true,
      batchSize: 100,
      // Jobs queued before the record type was part of the input still check it in each batch.
      requires: (input) => (input.recordType ? `record:${input.recordType}:import` : undefined),
      run: (job) => this.runBatch(job),
      notice: (job) => this.notice(job),
    });
  }

  async upload(ctx: TenantContext, typeKey: string, body: UploadInput['body'], name: string): Promise<ImportView> {
    demand(ctx.actor, `record:${typeKey}:import`);
    const type = await this.typeOf(ctx, typeKey);
    const fileName = cleanFileName(name);
    if (!/\.csv$/i.test(fileName)) throw validationFailed('Choose a CSV file (.csv).');
    const file = await this.files.upload(ctx, { body, name: fileName, maxBytes: IMPORT_MAX_BYTES });
    if (file.mime !== 'text/csv') throw validationFailed('Choose a CSV file (.csv).');
    const { header, rows } = await this.read(ctx, file.id);
    if (!header.length) throw validationFailed('The file has no heading row.');
    if (!rows.length) throw validationFailed('The file has no rows to import.');
    if (rows.length > IMPORT_MAX_ROWS) throw validationFailed(`The file has ${rows.length} rows; at most ${IMPORT_MAX_ROWS} can be imported at once.`);
    const columns = header.map((c, i) => ({
      name: c,
      samples: rows
        .map((r) => (r.cells[i] ?? '').trim())
        .filter(Boolean)
        .slice(0, SAMPLES),
    }));
    const row = await this.tm.withTenant(ctx.tenantId, (tx) =>
      this.store.add(tx, { typeKey, fileId: file.id, fileName, columns, rowCount: rows.length, createdBy: ctx.actor.id }),
    );
    return this.view(ctx, row, type);
  }

  async get(ctx: TenantContext, id: string): Promise<ImportView> {
    let row = await this.load(ctx, id);
    if (row.status === 'running' && row.job_id) {
      const job = await this.jobs.get(ctx, row.job_id).catch(() => null);
      if (job && (job.status === 'failed' || job.status === 'cancelled')) row = await this.setStatus(ctx, row.id, 'failed');
    }
    return this.view(ctx, row, await this.typeOf(ctx, row.type_key));
  }

  /**
   * Saves the column matches. Columns left out of `columns` keep the suggested
   * field; null leaves a column out. `updateBy` names a unique field that
   * finds the record to update; rows without a match create one.
   */
  async setMapping(ctx: TenantContext, id: string, input: MappingInput): Promise<ImportView> {
    const row = await this.load(ctx, id);
    if (!['uploaded', 'mapped', 'checked'].includes(row.status)) throw conflict('This import has already started.');
    const type = await this.typeOf(ctx, row.type_key);
    const names = row.columns.map((c) => c.name);
    const columns = suggestMapping(type, names);
    const given = input.columns && typeof input.columns === 'object' ? input.columns : {};
    for (const [name, value] of Object.entries(given)) {
      if (!names.includes(name)) throw validationFailed(`The file has no column '${name}'.`);
      if (value === null || value === '') {
        columns[name] = null;
        continue;
      }
      const f = type.fields.find((x) => x.key === value);
      if (typeof value !== 'string' || !f) throw validationFailed(`'${String(value)}' is not a field of ${type.label}.`);
      if (!importable(f)) throw validationFailed(`'${f.label}' cannot be imported.`);
      columns[name] = f.key;
    }
    const mapped = Object.values(columns).filter((v): v is string => !!v);
    const twice = mapped.find((k, i) => mapped.indexOf(k) !== i);
    if (twice) throw validationFailed(`More than one column fills '${type.fields.find((f) => f.key === twice)!.label}'.`);
    if (!mapped.length) throw validationFailed('Match at least one column to a field.');
    let updateBy: string | undefined;
    if (input.updateBy !== undefined && input.updateBy !== null && input.updateBy !== '') {
      const f = type.fields.find((x) => x.key === input.updateBy);
      if (!f?.unique) throw validationFailed('Records can be updated only by a unique field.');
      if (!mapped.includes(f.key)) throw validationFailed(`Match a column to '${f.label}' to update records by it.`);
      updateBy = f.key;
    }
    const quiet = input.quiet === true;
    if (quiet) demand(ctx.actor, `record:${row.type_key}:import:quiet`);
    const mapping: ImportMapping = { columns, ...(updateBy ? { updateBy } : {}) };
    const saved = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.saveMapping(tx, row.id, mapping, quiet ? { quiet } : {}));
    if (!saved) throw conflict('This import has already started.');
    return this.view(ctx, saved, type);
  }

  /** Every row through the record engine's checks, without saving anything. */
  async check(ctx: TenantContext, id: string): Promise<CheckResult> {
    const row = await this.load(ctx, id);
    if (row.status !== 'mapped' && row.status !== 'checked') throw conflict(row.mapping ? 'This import has already started.' : 'Match the columns first.');
    const type = await this.typeOf(ctx, row.type_key);
    const { rows } = await this.read(ctx, row.file_id);
    const result: CheckResult = { rows: rows.length, valid: 0, invalid: 0, creates: 0, updates: 0, problems: [] };
    const seen = new Map<string, Map<string, number>>();
    const refs = new Map<string, Promise<string>>();
    for (const r of rows) {
      const outcome = await this.prepareRow(ctx, type, row, r, refs);
      let problems = outcome.problems;
      if (!problems.length) {
        try {
          await this.records.check(ctx, type.key, { data: outcome.data, id: outcome.existing?.id });
        } catch (e) {
          if (!(e instanceof PlatformError)) throw e;
          problems = problemsOf(e, r.row, type, outcome.columnOf);
        }
      }
      if (!problems.length) problems = this.duplicatesInFile(type, outcome, r.row, seen);
      if (problems.length) {
        result.invalid++;
        for (const p of problems) if (result.problems.length < PROBLEMS_SHOWN) result.problems.push(p);
        continue;
      }
      result.valid++;
      if (outcome.existing) result.updates++;
      else result.creates++;
    }
    await this.tm.withTenant(ctx.tenantId, (tx) => this.store.saveCheck(tx, row.id, result));
    return result;
  }

  /** Starts the import job; one import runs at a time per organisation. */
  async run(ctx: TenantContext, id: string): Promise<ImportView> {
    const row = await this.load(ctx, id);
    if (row.status !== 'mapped' && row.status !== 'checked') throw conflict(row.mapping ? 'This import has already started.' : 'Match the columns first.');
    if (row.options.quiet) demand(ctx.actor, `record:${row.type_key}:import:quiet`);
    const type = await this.typeOf(ctx, row.type_key);
    const claimed = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.claim(tx, row.id));
    if (!claimed) throw conflict('This import has already started.');
    let job: JobView;
    try {
      job = await this.jobs.create(ctx, 'import', { importId: row.id, recordType: row.type_key }, row.row_count);
    } catch (error) {
      await this.setStatus(ctx, row.id, row.status);
      throw error;
    }
    const saved = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.setJob(tx, row.id, job.id));
    return this.view(ctx, saved!, type);
  }

  /** The rows that failed, as they were in the file, with the reason in a last column. */
  async *failedCsv(ctx: TenantContext, id: string): AsyncGenerator<string> {
    const row = await this.load(ctx, id);
    if (!row.job_id) throw conflict('This import has not run yet.');
    yield `\uFEFF${this.csv.csvLine([...row.columns.map((c) => c.name), 'Reason'])}`;
    const jobId = row.job_id;
    for (let after = 0; ; ) {
      const from = after;
      const items = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.failedRows(tx, jobId, from, 1000));
      for (const item of items) {
        const cells = row.columns.map((_, i) => item.data?.cells?.[i] ?? '');
        yield this.csv.csvLine([...cells, item.message ?? '']);
      }
      if (items.length < 1000) return;
      after = items.at(-1)!.seq;
    }
  }

  // ---------------------------------------------------------------- the job

  private async runBatch({ ctx, input, state, batchSize }: JobRun<{ importId: string }, ImportState>): Promise<JobBatch<ImportState>> {
    const row = await this.load(ctx, input.importId);
    const type = await this.typeOf(ctx, row.type_key);
    const { rows } = await this.read(ctx, row.file_id);
    const next = state.next ?? 0;
    const counts = { created: state.created ?? 0, updated: state.updated ?? 0, failed: state.failed ?? 0 };

    if (next >= rows.length) {
      const parents = state.parents ?? [];
      await this.records.recomputeRollups(ctx.tenantId, parents.slice(0, ROLLUPS_PER_BATCH));
      const rest = parents.slice(ROLLUPS_PER_BATCH);
      if (rest.length) return { state: { ...state, parents: rest }, progress: rows.length, done: false };
      await this.setStatus(ctx, row.id, 'done');
      return { state: { ...state, parents: [] }, progress: rows.length, done: true, result: { importId: row.id, type: row.type_key, ...counts } };
    }

    const deferred = new Set<string>(state.parents ?? []);
    const saveCtx: TenantContext = { ...ctx, quiet: row.options.quiet === true, deferredRollups: deferred };
    const refs = new Map<string, Promise<string>>();
    const items: JobItemResult[] = [];
    const batch = rows.slice(next, next + batchSize);
    for (const r of batch) {
      const outcome = await this.prepareRow(ctx, type, row, r, refs);
      let problems = outcome.problems;
      if (!problems.length) {
        try {
          if (outcome.existing) {
            const saved = await this.records.update(saveCtx, outcome.existing.id, { data: outcome.data, expectedVersion: outcome.existing.version });
            items.push({ seq: r.row, status: 'done', recordId: saved.record.id, data: { action: 'updated' } });
            counts.updated++;
          } else {
            const saved = await this.records.create(saveCtx, type.key, outcome.data);
            items.push({ seq: r.row, status: 'done', recordId: saved.record.id, data: { action: 'created' } });
            counts.created++;
          }
          continue;
        } catch (e) {
          if (!(e instanceof PlatformError)) throw e;
          problems = problemsOf(e, r.row, type, outcome.columnOf);
        }
      }
      items.push({ seq: r.row, status: 'failed', message: reasonOf(problems), data: { cells: r.cells } });
      counts.failed++;
    }
    const progress = next + batch.length;
    return {
      state: { next: progress, ...counts, parents: [...deferred] },
      items,
      progress,
      total: rows.length,
      done: false,
    };
  }

  private notice(job: JobView) {
    const r = job.result as { importId?: string; type?: string; created?: number; updated?: number; failed?: number } | null;
    if (job.status !== 'done' || !r?.importId) {
      return { subject: job.status === 'cancelled' ? 'Import cancelled' : 'Import failed', body: job.error ? `Import stopped: ${job.error}.` : 'Import stopped.' };
    }
    return {
      subject: 'Import finished',
      body: `Import finished: ${r.created ?? 0} created, ${r.updated ?? 0} updated, ${r.failed ?? 0} failed.`,
      link: `/records/${r.type}?import=${r.importId}&importStep=5`,
    };
  }

  // ---------------------------------------------------------------- helpers

  /** A row as record data, with problems reading its cells, and the record it updates when one matches. */
  private async prepareRow(
    ctx: TenantContext,
    type: RecordTypeDef,
    imp: ImportRow,
    r: DataRow,
    refs: Map<string, Promise<string>>,
  ): Promise<{ data: Record<string, unknown>; problems: ImportProblem[]; existing: { id: string; version: number } | null; columnOf: Map<string, string> }> {
    const mapping = imp.mapping ?? { columns: {} };
    const data: Record<string, unknown> = {};
    const problems: ImportProblem[] = [];
    const columnOf = new Map<string, string>();
    for (const [i, col] of imp.columns.entries()) {
      const key = mapping.columns[col.name];
      const f = key ? type.fields.find((x) => x.key === key) : undefined;
      if (!f) continue;
      columnOf.set(f.key, col.name);
      const raw = (r.cells[i] ?? '').trim();
      if (raw === '') continue;
      const parsed = await readCell(ctx, this.records, f, raw, refs);
      if ('error' in parsed) problems.push({ row: r.row, column: col.name, field: f.key, message: `${f.label} ${parsed.error}` });
      else data[f.key] = parsed.value;
    }
    let existing: { id: string; version: number } | null = null;
    const by = mapping.updateBy;
    const match = by && !problems.length ? data[by] : undefined;
    if (by && (typeof match === 'string' || typeof match === 'number')) existing = await this.records.findByUnique(ctx, type.key, by, String(match));
    return { data, problems, existing, columnOf };
  }

  /** Two rows of the file that would give records the same unique value. */
  private duplicatesInFile(
    type: RecordTypeDef,
    outcome: { data: Record<string, unknown>; existing: { id: string } | null; columnOf: Map<string, string> },
    row: number,
    seen: Map<string, Map<string, number>>,
  ): ImportProblem[] {
    const problems: ImportProblem[] = [];
    for (const f of type.fields) {
      const v = outcome.data[f.key];
      if (!f.unique || v === undefined || v === null || v === '') continue;
      const values = seen.get(f.key) ?? new Map<string, number>();
      seen.set(f.key, values);
      const norm = String(v).trim().toLowerCase();
      const first = values.get(norm);
      if (first !== undefined) {
        problems.push({ row, ...(outcome.columnOf.has(f.key) ? { column: outcome.columnOf.get(f.key) } : {}), field: f.key, message: `Row ${first} of the file has the same ${f.label}.` });
      } else values.set(norm, row);
    }
    return problems;
  }

  /** The file's heading and data rows (blank rows dropped), read once and kept for the import's later steps. */
  private async read(ctx: TenantContext, fileId: string): Promise<{ header: string[]; rows: DataRow[] }> {
    const hit = this.parsed.get(fileId);
    if (hit) return hit;
    const { body } = await this.files.open(ctx, fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const out = csvTable(this.csv.parseCsv(Buffer.concat(chunks).toString('utf8')));
    if (this.parsed.size >= 4) this.parsed.delete(this.parsed.keys().next().value!);
    this.parsed.set(fileId, out);
    return out;
  }

  /** The import, for the person who uploaded it while they may still import into its record type. */
  private async load(ctx: TenantContext, id: string): Promise<ImportRow> {
    if (!UUID.test(id)) throw notFound('Import not found.');
    const row = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.get(tx, id));
    if (!row || row.created_by !== ctx.actor.id) throw notFound('Import not found.');
    demand(ctx.actor, `record:${row.type_key}:import`);
    return row;
  }

  private async setStatus(ctx: TenantContext, id: string, status: ImportStatus): Promise<ImportRow> {
    const row = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.setStatus(tx, id, status));
    return row!;
  }

  private async typeOf(ctx: TenantContext, typeKey: string): Promise<RecordTypeDef> {
    const type = await this.defs.get(ctx.tenantId, 'recordType', typeKey);
    if (!type) throw notFound(`Unknown record type '${typeKey}'.`);
    return type.body;
  }

  private async view(ctx: TenantContext, row: ImportRow, type: RecordTypeDef): Promise<ImportView> {
    let counts: ImportView['counts'] = null;
    const jobId = row.job_id;
    if (jobId) {
      counts = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.counts(tx, jobId));
    }
    return {
      id: row.id,
      type: row.type_key,
      fileId: row.file_id,
      fileName: row.file_name,
      columns: row.columns,
      rowCount: row.row_count,
      mapping: row.mapping,
      suggested: suggestMapping(type, row.columns.map((c) => c.name)),
      options: row.options ?? {},
      status: row.status,
      check: row.check_result,
      jobId: row.job_id,
      counts,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
}
