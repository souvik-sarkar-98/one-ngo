import { conflict, notFound, PlatformError, validationFailed } from '@onengo/kernel/errors';
import type { LedgerService } from '../../domain/ledger/ledger-service.js';
import { can, demand } from '../../domain/permissions.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { ReceiptService } from '../../domain/receipts/receipt-service.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import type { RecordTypeDef } from '../../runtime/definitions/types.js';
import type { JobBatch, JobItemResult, JobRun, JobRunner, JobView } from '../../runtime/records/ports/job-runner.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { FileService, UploadInput } from '../files/file-service.js';
import type { CsvCodec } from '../records/ports/csv-codec.js';
import { cleanFileName } from '../shared/file-name.js';
import { csvTable, problemsOf, readCell, type CellProblem, type CsvRow } from '../shared/import-cells.js';
import { applyBooks, hasBooks, readBooks, type BooksInput, type BooksResult } from './books.js';
import { checkOrder, deriveOrder, MAX_SOURCES, readMapping, type MigrationTarget, type OrderedSource, type SourceMapping, type TypesByKey } from './mapping.js';
import type { MigrationStore, ProfileRow, SourceCounts, SourceRow } from './ports/migration-store.js';

export type { BooksInput, BooksResult } from './books.js';
export type { MigrationRef, MigrationTarget, SourceMapping } from './mapping.js';

const MB = 1024 * 1024;
export const MIGRATION_MAX_BYTES = 10 * MB;
export const MIGRATION_MAX_ROWS = 20_000;
/** Job items of one file are numbered from its place in the run times this, plus the row. */
const SEQ_PER_SOURCE = 1_000_000;
const PROBLEMS_SHOWN = 200;
const SAMPLES = 3;
const ROLLUPS_PER_BATCH = 200;
const KEY_CHUNK = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MIGRATE = 'data:migrate';
export const MIGRATE_BOOKS = 'data:migrate:books';

export type ProfileStatus = 'draft' | 'checked' | 'running' | 'done' | 'failed';

export interface MigrationColumn {
  name: string;
  samples: string[];
}

export interface MigrationProblem extends CellProblem {
  sourceId: string;
  fileName: string;
  /** The target the problem is about, when it is one target's. */
  target?: string;
}

export interface SourceCheck {
  sourceId: string;
  fileName: string;
  rows: number;
  ready: number;
  invalid: number;
  creates: number;
  updates: number;
}

/** What a run would do, file by file, with the first problems; nothing is saved. */
export interface MigrationCheck {
  rows: number;
  ready: number;
  invalid: number;
  creates: number;
  updates: number;
  sources: SourceCheck[];
  problems: MigrationProblem[];
  checkedAt: string;
}

export interface SourceView {
  id: string;
  fileName: string;
  columns: MigrationColumn[];
  rowCount: number;
  position: number;
  mapping: SourceMapping | null;
  /** After a run: records created and updated, and rows that failed. */
  counts: SourceCounts | null;
}

export interface ProfileSummary {
  id: string;
  name: string;
  status: ProfileStatus;
  files: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileView extends Omit<ProfileSummary, 'files'> {
  sources: SourceView[];
  books: BooksInput;
  booksAppliedAt: string | null;
  booksResult: BooksResult | null;
  check: MigrationCheck | null;
  jobId: string | null;
}

interface RunState {
  order?: string[];
  index?: number;
  next?: number;
  progress?: number;
  parents?: string[];
}

/** A row whose required target cannot be written; the row's other records roll back with it. */
class RowFailure extends Error {
  constructor(readonly problems: CellProblem[]) {
    super('row failed');
  }
}

interface Prepared {
  /** The old id is blank: an optional target is left out, a required one fails the row. */
  blank: boolean;
  oldId: string;
  data: Record<string, unknown>;
  problems: CellProblem[];
  columnOf: Map<string, string>;
  /** Reference fields that point at a record the check expects an earlier row or file to create. */
  pending: Set<string>;
}

/** A record by old id: its id, `pending` when the check expects it to be created first, or null. */
type OldIdLookup = (typeKey: string, oldId: string) => Promise<string | 'pending' | null>;

const iso = (v: string | Date) => new Date(v).toISOString();
const reasonOf = (problems: CellProblem[]) => problems.map((p) => p.message).join('; ');

/**
 * Data migration: CSV files exported from another system, each mapped onto one or more record
 * types, checked without saving and run in order by a job. The old id of every record written is
 * kept, so a later file can point at it and a second run updates it. The opening journal and the
 * next receipt numbers are applied once, after every file has loaded.
 */
export class MigrationService {
  private readonly parsed = new Map<string, { header: string[]; rows: CsvRow[] }>();

  constructor(
    private readonly tm: TransactionManager,
    private readonly store: MigrationStore,
    private readonly defs: DefinitionReader,
    private readonly records: RecordService,
    private readonly files: FileService,
    private readonly jobs: JobRunner,
    private readonly csv: CsvCodec,
    private readonly ledger: Pick<LedgerService, 'post'>,
    private readonly receipts: Pick<ReceiptService, 'continueNumbering'>,
    private readonly audit: AuditTrail,
  ) {
    jobs.register<{ profileId: string }, RunState>('migration', {
      label: 'Data migration',
      exclusive: true,
      batchSize: 100,
      requires: () => MIGRATE,
      run: (job) => this.runBatch(job),
      notice: (job) => this.notice(job),
    });
  }

  // ------------------------------------------------------------- profiles

  async create(ctx: TenantContext, input: { name?: unknown }): Promise<ProfileView> {
    demand(ctx.actor, MIGRATE);
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120) throw validationFailed('Name the migration (at most 120 characters).', [{ path: '/name', message: 'is required' }]);
    const row = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const p = await this.store.addProfile(tx, { name, createdBy: ctx.actor.id });
      await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'migration.created', entity: 'migration', entityId: p.id, after: { name } });
      return p;
    });
    return this.view(ctx, row);
  }

  async list(ctx: TenantContext): Promise<{ items: ProfileSummary[] }> {
    demand(ctx.actor, MIGRATE);
    return this.tm.withTenant(
      ctx.tenantId,
      async (tx) => {
        const rows = await this.store.profiles(tx, 100);
        const items: ProfileSummary[] = [];
        for (const r of rows) {
          const sources = await this.store.sources(tx, r.id);
          items.push({ id: r.id, name: r.name, status: r.status, files: sources.length, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
        }
        return { items };
      },
      { readOnly: true },
    );
  }

  async get(ctx: TenantContext, id: string): Promise<ProfileView> {
    let row = await this.load(ctx, id);
    if (row.status === 'running' && row.job_id) {
      const job = await this.jobs.get(ctx, row.job_id).catch(() => null);
      if (job && (job.status === 'failed' || job.status === 'cancelled')) {
        await this.tm.withTenant(ctx.tenantId, (tx) => this.store.setStatus(tx, row.id, 'failed'));
        row = await this.load(ctx, id);
      }
    }
    return this.view(ctx, row);
  }

  // ---------------------------------------------------------------- files

  /** Adds a CSV of any columns; it loads only once it has a mapping. */
  async addSource(ctx: TenantContext, id: string, body: UploadInput['body'], name: string): Promise<ProfileView> {
    const profile = await this.editable(ctx, id);
    const fileName = cleanFileName(name);
    if (!/\.csv$/i.test(fileName)) throw validationFailed('Choose a CSV file (.csv). Export each table of the old system as CSV.');
    const existing = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.sources(tx, profile.id));
    if (existing.length >= MAX_SOURCES) throw validationFailed(`A migration can hold at most ${MAX_SOURCES} files.`);
    if (existing.some((s) => s.file_name.toLowerCase() === fileName.toLowerCase())) throw conflict(`This migration already has a file named ${fileName}. Remove it first to replace it.`);
    const file = await this.files.upload(ctx, { body, name: fileName, maxBytes: MIGRATION_MAX_BYTES });
    if (file.mime !== 'text/csv') throw validationFailed('Choose a CSV file (.csv). Export each table of the old system as CSV.');
    const { header, rows } = await this.read(ctx, file.id);
    if (!header.length) throw validationFailed('The file has no heading row.');
    if (!rows.length) throw validationFailed('The file has no rows.');
    if (rows.length > MIGRATION_MAX_ROWS) throw validationFailed(`The file has ${rows.length} rows; at most ${MIGRATION_MAX_ROWS} can be loaded from one file. Split it into several files.`);
    const columns = header.map((c, i) => ({
      name: c,
      samples: rows
        .map((r) => (r.cells[i] ?? '').trim())
        .filter(Boolean)
        .slice(0, SAMPLES),
    }));
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const added = await this.store.addSource(tx, { profileId: profile.id, fileId: file.id, fileName, columns, rowCount: rows.length });
      if (!added) throw conflict(`This migration already has a file named ${fileName}. Remove it first to replace it.`);
      await this.store.reset(tx, profile.id);
    });
    return this.get(ctx, profile.id);
  }

  async removeSource(ctx: TenantContext, id: string, sourceId: string): Promise<ProfileView> {
    const profile = await this.editable(ctx, id);
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      if (!UUID.test(sourceId) || !(await this.store.removeSource(tx, profile.id, sourceId))) throw notFound('File not found.');
      await this.store.reset(tx, profile.id);
    });
    return this.get(ctx, profile.id);
  }

  /**
   * Saves which record types a file fills and from which columns. When the file now looks up
   * records another file writes later, the files are reordered so it waits for that file.
   */
  async setMapping(ctx: TenantContext, id: string, sourceId: string, input: unknown): Promise<ProfileView> {
    const profile = await this.editable(ctx, id);
    const types = await this.types(ctx);
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const sources = await this.store.sources(tx, profile.id);
      const source = sources.find((s) => s.id === sourceId);
      if (!source) throw notFound('File not found.');
      const mapping = readMapping(input, source.columns.map((c) => c.name), types);
      for (const t of mapping.targets) demand(ctx.actor, `record:${t.type}:import`);
      const next = sources.map((s) => (s.id === source.id ? { ...s, mapping } : s));
      const ordered = deriveOrder(next.map(ordering), types);
      if (ordered.some((s, i) => s.id !== next[i]!.id)) await this.store.setOrder(tx, profile.id, ordered.map((s) => s.id));
      await this.store.saveMapping(tx, profile.id, source.id, mapping);
      await this.store.reset(tx, profile.id);
    });
    return this.get(ctx, profile.id);
  }

  /** Puts every file of the profile in the given order; a file may not load before one it looks up. */
  async setOrder(ctx: TenantContext, id: string, input: { sourceIds?: unknown }): Promise<ProfileView> {
    const profile = await this.editable(ctx, id);
    const ids = Array.isArray(input?.sourceIds) ? input.sourceIds : null;
    const types = await this.types(ctx);
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const sources = await this.store.sources(tx, profile.id);
      const byId = new Map(sources.map((s) => [s.id, s]));
      if (!ids || ids.length !== sources.length || new Set(ids).size !== ids.length || ids.some((x) => typeof x !== 'string' || !byId.has(x))) {
        throw validationFailed('List every file of this migration once.', [{ path: '/sourceIds', message: 'must list every file once' }]);
      }
      checkOrder((ids as string[]).map((x) => ordering(byId.get(x)!)), types);
      await this.store.setOrder(tx, profile.id, ids as string[]);
      await this.store.reset(tx, profile.id);
    });
    return this.get(ctx, profile.id);
  }

  // ---------------------------------------------------------------- books

  async setBooks(ctx: TenantContext, id: string, input: unknown): Promise<ProfileView> {
    const profile = await this.editable(ctx, id);
    demand(ctx.actor, MIGRATE_BOOKS);
    if (profile.books_applied_at) throw conflict('The books of this migration have already been applied.');
    const books = readBooks(input);
    await this.tm.withTenant(ctx.tenantId, (tx) => this.store.saveBooks(tx, profile.id, books));
    return this.get(ctx, profile.id);
  }

  /** Applies the books of a finished run; after a failure, once the cause is fixed. */
  async applyBooks(ctx: TenantContext, id: string): Promise<ProfileView> {
    const profile = await this.load(ctx, id);
    demand(ctx.actor, MIGRATE_BOOKS);
    if (profile.status !== 'done') throw conflict('The books apply after every file has loaded. Run the migration first.');
    if (profile.books_applied_at) throw conflict('The books of this migration have already been applied.');
    if (!hasBooks(profile.books)) throw validationFailed('This migration has no opening balances or receipt numbers to apply.');
    const outcome = await this.putBooks(ctx, profile.id);
    if ('error' in outcome) throw outcome.error;
    return this.get(ctx, profile.id);
  }

  /** Posts the books in one transaction and records the outcome either way. */
  private async putBooks(ctx: TenantContext, id: string): Promise<{ result: BooksResult } | { error: PlatformError }> {
    try {
      const result = await this.tm.withTenant(ctx.tenantId, async (tx) => {
        const locked = await this.store.lockProfile(tx, id);
        if (!locked) throw notFound('Migration not found.');
        if (locked.books_applied_at) throw conflict('The books of this migration have already been applied.');
        const out = await applyBooks(tx, ctx.actor, locked.books, this.ledger, this.receipts);
        await this.store.saveBooksResult(tx, id, out, true);
        await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'migration.books_applied', entity: 'migration', entityId: id, after: { books: locked.books, result: out } });
        return out;
      });
      return { result };
    } catch (e) {
      if (!(e instanceof PlatformError)) throw e;
      if (e.code !== 'conflict') await this.tm.withTenant(ctx.tenantId, (tx) => this.store.saveBooksResult(tx, id, { error: e.message }, false));
      return { error: e };
    }
  }

  // ----------------------------------------------------------- check, run

  /** Every row of every mapped file through the record engine's checks, in load order, without saving. */
  async check(ctx: TenantContext, id: string): Promise<ProfileView> {
    const profile = await this.editable(ctx, id);
    const types = await this.types(ctx);
    const sources = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.sources(tx, profile.id));
    const mapped = sources.filter((s) => s.mapping);
    if (!mapped.length) throw validationFailed('Match at least one file to a record type first.');
    checkOrder(sources.map(ordering), types);
    for (const s of mapped) for (const t of s.mapping!.targets) demand(ctx.actor, `record:${t.type}:import`);

    const result: MigrationCheck = { rows: 0, ready: 0, invalid: 0, creates: 0, updates: 0, sources: [], problems: [], checkedAt: new Date().toISOString() };
    const planned = new Map<string, Set<string>>();
    const plan = (typeKey: string, oldId: string) => {
      const set = planned.get(typeKey) ?? new Set<string>();
      planned.set(typeKey, set);
      set.add(oldId);
    };
    const refs = new Map<string, Promise<string>>();
    for (const source of mapped) {
      const mapping = source.mapping!;
      const { rows } = await this.read(ctx, source.file_id);
      const at = columnIndex(source);
      const known = await this.knownKeys(ctx, mapping, types, rows, at);
      const lookup: OldIdLookup = async (typeKey, oldId) => known.get(typeKey)?.get(oldId)?.recordId ?? (planned.get(typeKey)?.has(oldId) ? 'pending' : null);
      const counts: SourceCheck = { sourceId: source.id, fileName: source.file_name, rows: rows.length, ready: 0, invalid: 0, creates: 0, updates: 0 };
      for (const r of rows) {
        const written = new Map<string, string>();
        const rowProblems: MigrationProblem[] = [];
        let creates = 0;
        let updates = 0;
        const toPlan: [string, string][] = [];
        for (const t of mapping.targets) {
          const type = types.get(t.type)!;
          const p = await this.prepare(ctx, type, t, at, r, refs, lookup, written);
          const tag = (problems: CellProblem[]) => problems.map((x) => ({ ...x, sourceId: source.id, fileName: source.file_name, target: t.key }));
          if (p.blank) {
            if (!t.required) continue;
            rowProblems.push(...tag([blankOldId(r.row, t)]));
            break;
          }
          let problems = p.problems;
          const existing = known.get(t.type)?.get(p.oldId);
          if (!problems.length) {
            try {
              await this.records.check(ctx, t.type, { data: p.data, ...(existing ? { id: existing.recordId } : {}) });
            } catch (e) {
              if (!(e instanceof PlatformError)) throw e;
              problems = problemsOf(e, r.row, type, p.columnOf).filter((x) => !x.field || !p.pending.has(x.field));
            }
          }
          if (problems.length) {
            if (t.required) {
              rowProblems.push(...tag(problems));
              break;
            }
            continue;
          }
          toPlan.push([t.type, p.oldId]);
          written.set(t.key, existing?.recordId ?? 'pending');
          if (existing) updates++;
          else creates++;
        }
        if (rowProblems.length) {
          counts.invalid++;
          for (const x of rowProblems) if (result.problems.length < PROBLEMS_SHOWN) result.problems.push(x);
          continue;
        }
        for (const [typeKey, oldId] of toPlan) plan(typeKey, oldId);
        counts.ready++;
        counts.creates += creates;
        counts.updates += updates;
      }
      result.sources.push(counts);
      result.rows += counts.rows;
      result.ready += counts.ready;
      result.invalid += counts.invalid;
      result.creates += counts.creates;
      result.updates += counts.updates;
    }
    await this.tm.withTenant(ctx.tenantId, (tx) => this.store.saveCheck(tx, profile.id, result));
    return this.get(ctx, profile.id);
  }

  /** Starts the run of a checked migration; one migration or import runs at a time per organisation. */
  async run(ctx: TenantContext, id: string): Promise<ProfileView> {
    const profile = await this.load(ctx, id);
    if (profile.status === 'running') throw conflict('This migration is already running.');
    if (profile.status !== 'checked') throw conflict('Check the files before running the migration.');
    if (hasBooks(profile.books) && !profile.books_applied_at) demand(ctx.actor, MIGRATE_BOOKS);
    const sources = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.sources(tx, profile.id));
    for (const s of sources) for (const t of s.mapping?.targets ?? []) demand(ctx.actor, `record:${t.type}:import`);
    const total = sources.filter((s) => s.mapping).reduce((n, s) => n + s.row_count, 0);
    const claimed = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.claim(tx, profile.id));
    if (!claimed) throw conflict('This migration has changed or already started. Check it again.');
    let job: JobView;
    try {
      job = await this.jobs.create(ctx, 'migration', { profileId: profile.id }, total);
    } catch (error) {
      await this.tm.withTenant(ctx.tenantId, (tx) => this.store.setStatus(tx, profile.id, 'checked'));
      throw error;
    }
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      await this.store.setJob(tx, profile.id, job.id);
      await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'migration.started', entity: 'migration', entityId: profile.id, after: { jobId: job.id, rows: total } });
    });
    return this.get(ctx, profile.id);
  }

  /** Stops a running migration before its next batch. Rows already saved stay. */
  async cancel(ctx: TenantContext, id: string): Promise<ProfileView> {
    const profile = await this.load(ctx, id);
    if (profile.status !== 'running' || !profile.job_id) throw conflict('This migration is not running.');
    await this.jobs.cancel(ctx, profile.job_id);
    return this.get(ctx, profile.id);
  }

  /** One file's rows that failed in the last run, as they were in the file, with the reason last. */
  async *failedCsv(ctx: TenantContext, id: string, sourceId: string): AsyncGenerator<string> {
    const profile = await this.load(ctx, id);
    if (!profile.job_id) throw conflict('This migration has not run yet.');
    const source = (await this.tm.withTenant(ctx.tenantId, (tx) => this.store.sources(tx, profile.id))).find((s) => s.id === sourceId);
    if (!source) throw notFound('File not found.');
    yield `\uFEFF${this.csv.csvLine([...source.columns.map((c) => c.name), 'Reason'])}`;
    const jobId = profile.job_id;
    for (let after = 0; ; ) {
      const from = after;
      const items = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.failedRows(tx, jobId, source.id, from, 1000));
      for (const item of items) {
        const cells = source.columns.map((_, i) => item.data?.cells?.[i] ?? '');
        yield this.csv.csvLine([...cells, item.message ?? '']);
      }
      if (items.length < 1000) return;
      after = items.at(-1)!.seq;
    }
  }

  /** The file name of one of the profile's files, for the download. */
  async fileName(ctx: TenantContext, id: string, sourceId: string): Promise<string> {
    const profile = await this.load(ctx, id);
    const source = (await this.tm.withTenant(ctx.tenantId, (tx) => this.store.sources(tx, profile.id))).find((s) => s.id === sourceId);
    if (!source) throw notFound('File not found.');
    return source.file_name;
  }

  // -------------------------------------------------------------- the job

  private async runBatch({ ctx, jobId, input, state, batchSize }: JobRun<{ profileId: string }, RunState>): Promise<JobBatch<RunState>> {
    const profile = await this.load(ctx, input.profileId);
    const sources = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.sources(tx, profile.id));
    const order = state.order ?? sources.filter((s) => s.mapping).map((s) => s.id);
    const byId = new Map(sources.map((s) => [s.id, s]));
    const total = order.reduce((n, sid) => n + (byId.get(sid)?.row_count ?? 0), 0);
    let index = state.index ?? 0;
    let next = state.next ?? 0;
    let progress = state.progress ?? 0;
    const deferred = new Set<string>(state.parents ?? []);

    if (index >= order.length) {
      const parents = [...deferred];
      await this.records.recomputeRollups(ctx.tenantId, parents.slice(0, ROLLUPS_PER_BATCH));
      const rest = parents.slice(ROLLUPS_PER_BATCH);
      if (rest.length) return { state: { ...state, parents: rest }, progress, total, done: false };
      await this.tm.withTenant(ctx.tenantId, (tx) => this.store.setStatus(tx, profile.id, 'done'));
      let booksError: string | undefined;
      if (hasBooks(profile.books) && !profile.books_applied_at) {
        if (can(ctx.actor, MIGRATE_BOOKS)) {
          const outcome = await this.putBooks(ctx, profile.id);
          if ('error' in outcome) booksError = outcome.error.message;
        } else {
          booksError = 'You no longer have permission to apply the books.';
          await this.tm.withTenant(ctx.tenantId, (tx) => this.store.saveBooksResult(tx, profile.id, { error: booksError! }, false));
        }
      }
      const sum = sumCounts(await this.tm.withTenant(ctx.tenantId, (tx) => this.store.counts(tx, jobId)));
      return { state: { ...state, parents: [] }, progress, total, done: true, result: { profileId: profile.id, ...sum, ...(booksError ? { booksError } : {}) } };
    }

    const source = byId.get(order[index]!);
    if (!source?.mapping) {
      return { state: { order, index: index + 1, next: 0, progress, parents: [...deferred] }, progress, total, done: false };
    }
    const types = await this.types(ctx);
    const { rows } = await this.read(ctx, source.file_id);
    const at = columnIndex(source);
    const saveCtx: TenantContext = { ...ctx, quiet: true, deferredRollups: deferred };
    const refs = new Map<string, Promise<string>>();
    const items: JobItemResult[] = [];
    const batch = rows.slice(next, next + batchSize);
    for (const [i, r] of batch.entries()) {
      const seq = index * SEQ_PER_SOURCE + next + i + 1;
      items.push(await this.runRow(ctx, saveCtx, profile.id, source, source.mapping, types, at, r, refs, seq));
    }
    progress += batch.length;
    next += batch.length;
    if (next >= rows.length) {
      index++;
      next = 0;
    }
    return { state: { order, index, next, progress, parents: [...deferred] }, items, progress, total, done: false };
  }

  /** Writes one row's records in one transaction: all of its required targets, or none of them. */
  private async runRow(
    ctx: TenantContext,
    saveCtx: TenantContext,
    profileId: string,
    source: SourceRow,
    mapping: SourceMapping,
    types: TypesByKey,
    at: Map<string, number>,
    r: CsvRow,
    refs: Map<string, Promise<string>>,
    seq: number,
  ): Promise<JobItemResult> {
    try {
      const out = await this.records.saveTogether(saveCtx, async (rs, tx) => {
        const written = new Map<string, string>();
        const lookup: OldIdLookup = async (typeKey, oldId) => (await this.store.keys(tx, typeKey, [oldId])).get(oldId)?.recordId ?? null;
        let created = 0;
        let updated = 0;
        let first: string | undefined;
        const skipped: string[] = [];
        for (const t of mapping.targets) {
          const type = types.get(t.type);
          if (!type) throw new RowFailure([{ row: r.row, message: `Record type '${t.type}' no longer exists.` }]);
          const p = await this.prepare(ctx, type, t, at, r, refs, lookup, written);
          if (p.blank || p.problems.length) {
            if (t.required) throw new RowFailure(p.blank ? [blankOldId(r.row, t)] : p.problems);
            skipped.push(t.key);
            continue;
          }
          const existing = (await this.store.keys(tx, t.type, [p.oldId])).get(p.oldId);
          if (!t.required) {
            try {
              await rs.check(saveCtx, t.type, { data: p.data, ...(existing ? { id: existing.recordId } : {}) });
            } catch (e) {
              if (!(e instanceof PlatformError)) throw e;
              skipped.push(t.key);
              continue;
            }
          }
          let recordId: string;
          try {
            const saved = existing
              ? await rs.update(saveCtx, existing.recordId, { data: p.data, expectedVersion: existing.version })
              : await rs.create(saveCtx, t.type, p.data);
            recordId = saved.record.id;
          } catch (e) {
            if (e instanceof PlatformError) throw new RowFailure(problemsOf(e, r.row, type, p.columnOf));
            throw e;
          }
          await this.store.putKey(tx, { typeKey: t.type, oldId: p.oldId, recordId, profileId });
          written.set(t.key, recordId);
          first ??= recordId;
          if (existing) updated++;
          else created++;
        }
        return { created, updated, first, skipped };
      });
      return {
        seq,
        status: 'done',
        ...(out.first ? { recordId: out.first } : {}),
        data: { sourceId: source.id, created: out.created, updated: out.updated, ...(out.skipped.length ? { skipped: out.skipped } : {}) },
      };
    } catch (e) {
      if (e instanceof RowFailure) return { seq, status: 'failed', message: reasonOf(e.problems), data: { sourceId: source.id, cells: r.cells } };
      if (e instanceof PlatformError) return { seq, status: 'failed', message: e.message, data: { sourceId: source.id, cells: r.cells } };
      throw e;
    }
  }

  private notice(job: JobView) {
    const r = job.result as { profileId?: string; created?: number; updated?: number; failed?: number; booksError?: string } | null;
    if (job.status !== 'done' || !r?.profileId) {
      return { subject: job.status === 'cancelled' ? 'Data migration cancelled' : 'Data migration failed', body: job.error ? `Data migration stopped: ${job.error}.` : 'Data migration stopped.' };
    }
    const books = r.booksError ? ` The books were not applied: ${r.booksError}` : '';
    return {
      subject: 'Data migration finished',
      body: `Data migration finished: ${r.created ?? 0} records created, ${r.updated ?? 0} updated, ${r.failed ?? 0} rows failed.${books}`,
      link: `/admin/migration/${r.profileId}/result`,
    };
  }

  // ------------------------------------------------------------- helpers

  /** One target's record data from a row, with what could not be read. */
  private async prepare(
    ctx: TenantContext,
    type: RecordTypeDef,
    t: MigrationTarget,
    at: Map<string, number>,
    r: CsvRow,
    refs: Map<string, Promise<string>>,
    lookup: OldIdLookup,
    written: ReadonlyMap<string, string>,
  ): Promise<Prepared> {
    const cell = (column: string) => (r.cells[at.get(column) ?? -1] ?? '').trim();
    const oldId = cell(t.oldId);
    const out: Prepared = { blank: oldId === '', oldId, data: {}, problems: [], columnOf: new Map(), pending: new Set() };
    if (out.blank) return out;
    if (oldId.length > 200) {
      out.problems.push({ row: r.row, column: t.oldId, message: `${t.oldId} is longer than 200 characters` });
      return out;
    }
    for (const [fieldKey, column] of Object.entries(t.fields)) {
      const f = type.fields.find((x) => x.key === fieldKey);
      if (!f) continue;
      out.columnOf.set(f.key, column);
      const raw = cell(column);
      if (raw === '') continue;
      const parsed = await readCell(ctx, this.records, f, raw, refs);
      if ('error' in parsed) out.problems.push({ row: r.row, column, field: f.key, message: `${f.label} ${parsed.error}` });
      else out.data[f.key] = parsed.value;
    }
    for (const [fieldKey, ref] of Object.entries(t.refs)) {
      const f = type.fields.find((x) => x.key === fieldKey);
      if (!f?.referenceType) continue;
      if ('target' in ref) {
        const id = written.get(ref.target);
        if (id === 'pending') out.pending.add(f.key);
        else if (id) out.data[f.key] = id;
        continue;
      }
      out.columnOf.set(f.key, ref.column);
      const raw = cell(ref.column);
      if (raw === '') continue;
      const found = await lookup(f.referenceType, raw);
      if (found === 'pending') out.pending.add(f.key);
      else if (found) out.data[f.key] = found;
      else out.problems.push({ row: r.row, column: ref.column, field: f.key, message: `${f.label}: nothing loaded has old id '${raw}'` });
    }
    return out;
  }

  /** The records already loaded for the old ids a file names, by record type. */
  private async knownKeys(
    ctx: TenantContext,
    mapping: SourceMapping,
    types: TypesByKey,
    rows: CsvRow[],
    at: Map<string, number>,
  ): Promise<Map<string, Map<string, { recordId: string; version: number }>>> {
    const wanted = new Map<string, Set<string>>();
    const want = (typeKey: string, column: string) => {
      const set = wanted.get(typeKey) ?? new Set<string>();
      wanted.set(typeKey, set);
      const i = at.get(column);
      if (i === undefined) return;
      for (const r of rows) {
        const v = (r.cells[i] ?? '').trim();
        if (v) set.add(v);
      }
    };
    for (const t of mapping.targets) {
      want(t.type, t.oldId);
      const type = types.get(t.type);
      for (const [fieldKey, ref] of Object.entries(t.refs)) {
        const refType = type?.fields.find((f) => f.key === fieldKey)?.referenceType;
        if ('column' in ref && refType) want(refType, ref.column);
      }
    }
    return this.tm.withTenant(
      ctx.tenantId,
      async (tx) => {
        const out = new Map<string, Map<string, { recordId: string; version: number }>>();
        for (const [typeKey, ids] of wanted) {
          const all = [...ids];
          const found = new Map<string, { recordId: string; version: number }>();
          for (let i = 0; i < all.length; i += KEY_CHUNK) for (const [k, v] of await this.store.keys(tx, typeKey, all.slice(i, i + KEY_CHUNK))) found.set(k, v);
          out.set(typeKey, found);
        }
        return out;
      },
      { readOnly: true },
    );
  }

  private async types(ctx: TenantContext): Promise<TypesByKey> {
    const list = await this.defs.list(ctx.tenantId, 'recordType');
    return new Map(list.map((d) => [d.key, d.body]));
  }

  /** The file's heading and data rows, read once and kept for the migration's later steps. */
  private async read(ctx: TenantContext, fileId: string): Promise<{ header: string[]; rows: CsvRow[] }> {
    const hit = this.parsed.get(fileId);
    if (hit) return hit;
    const { body } = await this.files.open(ctx, fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const out = csvTable(this.csv.parseCsv(Buffer.concat(chunks).toString('utf8')));
    if (this.parsed.size >= 8) this.parsed.delete(this.parsed.keys().next().value!);
    this.parsed.set(fileId, out);
    return out;
  }

  private async load(ctx: TenantContext, id: string): Promise<ProfileRow> {
    demand(ctx.actor, MIGRATE);
    if (!UUID.test(id)) throw notFound('Migration not found.');
    const row = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.profile(tx, id));
    if (!row) throw notFound('Migration not found.');
    return row;
  }

  /** A profile whose files, mappings and books may change: it is not running. */
  private async editable(ctx: TenantContext, id: string): Promise<ProfileRow> {
    const row = await this.load(ctx, id);
    if (row.status === 'running') throw conflict('This migration is running. Wait for it to finish or cancel it.');
    return row;
  }

  private async view(ctx: TenantContext, row: ProfileRow): Promise<ProfileView> {
    return this.tm.withTenant(
      ctx.tenantId,
      async (tx: Tx) => {
        const sources = await this.store.sources(tx, row.id);
        const counts = row.job_id ? await this.store.counts(tx, row.job_id) : null;
        return {
          id: row.id,
          name: row.name,
          status: row.status,
          sources: sources.map((s) => ({
            id: s.id,
            fileName: s.file_name,
            columns: s.columns,
            rowCount: s.row_count,
            position: s.position,
            mapping: s.mapping,
            counts: counts ? (counts.get(s.id) ?? (s.mapping ? { created: 0, updated: 0, failed: 0 } : null)) : null,
          })),
          books: row.books ?? {},
          booksAppliedAt: row.books_applied_at ? iso(row.books_applied_at) : null,
          booksResult: row.books_result,
          check: row.check_result,
          jobId: row.job_id,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        };
      },
      { readOnly: true },
    );
  }
}

const ordering = (s: SourceRow): OrderedSource => ({ id: s.id, fileName: s.file_name, mapping: s.mapping });

const columnIndex = (s: SourceRow) => new Map(s.columns.map((c, i) => [c.name, i]));

const blankOldId = (row: number, t: MigrationTarget): CellProblem => ({ row, column: t.oldId, message: `${t.oldId} is empty; every row needs an old id` });

function sumCounts(counts: Map<string, SourceCounts>): SourceCounts {
  const out = { created: 0, updated: 0, failed: 0 };
  for (const c of counts.values()) {
    out.created += c.created;
    out.updated += c.updated;
    out.failed += c.failed;
  }
  return out;
}
