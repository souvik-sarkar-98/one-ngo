import { conflict, notFound, PlatformError, validationFailed } from '@onengo/kernel/errors';
import type { LedgerService } from '../../domain/ledger/ledger-service.js';
import type { MemberDirectory } from '../../domain/identity/ports/identity-directory.js';
import type { RoleStore } from '../../domain/identity/ports/role-store.js';
import { can, demand, mayGrant } from '../../domain/permissions.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { ReceiptService } from '../../domain/receipts/receipt-service.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import type { FieldDef, RecordTypeDef } from '../../runtime/definitions/types.js';
import type { JobBatch, JobItemResult, JobRun, JobRunner, JobView } from '../../runtime/records/ports/job-runner.js';
import { SHIPPED_LOCALES } from '../../runtime/definitions/messages.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { FileService, UploadInput } from '../files/file-service.js';
import type { IdentityService } from '../identity/identity-service.js';
import type { RetentionScan } from '../files/ports/retention-scan.js';
import type { CsvCodec } from '../records/ports/csv-codec.js';
import { cleanFileName } from '../shared/file-name.js';
import { csvTable, problemsOf, readCell, type CellProblem, type CsvRow } from '../shared/import-cells.js';
import { applyBooks, hasBooks, readBooks, type BooksInput, type BooksResult } from './books.js';
import { checkOrder, deriveOrder, isPeople, MAX_SOURCES, readSourceMapping, targetsOf, type MigrationTarget, type OrderedSource, type PeopleMapping, type RecordsMapping, type SourceMapping, type TypesByKey } from './mapping.js';
import { CANNOT_ADD, LINKED_ELSEWHERE, readPersonRow, type ParsedPerson, type PersonEnv, type RoleRule } from './people.js';
import { typeGuards } from './guards.js';
import type { AttachmentInfo, AttachmentItem, LinkedPerson, MigrationStore, ProfileRow, SourceCounts, SourceRow } from './ports/migration-store.js';
import { kindOfMime } from '../../runtime/records/file-kinds.js';

export type { BooksInput, BooksResult } from './books.js';
export type { FileMapping, MigrationRef, MigrationTarget, PersonMapping, PeopleMapping, PeopleSpec, RecordsMapping, SourceMapping } from './mapping.js';

const MB = 1024 * 1024;
/** Attachments one profile holds, and the longest relative path of one. */
export const MIGRATION_MAX_ATTACHMENTS = 5000;
export const MIGRATION_MAX_PATH = 255;
export const MIGRATION_MAX_BYTES = 10 * MB;
export const MIGRATION_MAX_ROWS = 20_000;
/** Job items of one file are numbered from its place in the run times this, plus the row. */
const SEQ_PER_SOURCE = 1_000_000;
const PROBLEMS_SHOWN = 200;
const SAMPLES = 3;
const WARNING_SAMPLES = 5;
/**
 * A finished or failed migration's source files and failed-row data are deleted this many days
 * after it last changed (R6: this may become a setting).
 */
export const MIGRATION_RETENTION_DAYS = 30;
const PURGES_PER_BATCH = 20;
const ROLLUPS_PER_BATCH = 200;
const KEY_CHUNK = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MIGRATE = 'data:migrate';
export const MIGRATE_BOOKS = 'data:migrate:books';
export const MIGRATE_PEOPLE = 'data:migrate:people';
const MEMBERS_MANAGE = 'members:manage';

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
  /** Default `error`: it blocks the row (or, for a guard, every row of the type). A `warning` never blocks. */
  severity?: 'error' | 'warning';
}

/** Something to know before running that does not block it, grouped by kind and file so the check stays small. */
export interface MigrationWarning {
  kind: string;
  sourceId: string | null;
  fileName: string | null;
  count: number;
  /** The file column the warning is about, when it is one column's (unresolved legacy user ids). */
  column?: string;
  /** At most five examples. */
  samples: string[];
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
  /** Missing in checks stored before warnings existed; read as empty. */
  warnings: MigrationWarning[];
  checkedAt: string;
}

export interface SourceView {
  id: string;
  fileName: string;
  columns: MigrationColumn[];
  rowCount: number;
  position: number;
  /** What the file fills: records (also while it has no mapping) or people. */
  kind: 'records' | 'people';
  mapping: SourceMapping | null;
  /** When the file was deleted by a purge; null while it is stored. A purged file cannot be checked or run. */
  purgedAt: string | null;
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
  /** When the source files and failed-row data were deleted; null before. */
  purgedAt: string | null;
  /** The files uploaded for file columns to name. */
  attachments: { count: number; bytes: number };
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
  /** Person columns whose legacy user id nothing loaded stands for; the field is left blank (`onMissing: 'blank'`). */
  unresolved: { column: string; oldId: string }[];
  /** The attachments the row's file columns name, found. */
  attached: { fileId: string; size: number; recordId: string | null; name: string; column: string; field: string }[];
  /** Names no attachment has, left out (`onMissing: 'skip'`). */
  skippedFiles: { column: string; name: string }[];
}

/** The attachments at the given lowercased paths. */
type FileLookup = (lowerPaths: string[]) => Promise<ReadonlyMap<string, AttachmentInfo>>;
const noFiles: FileLookup = async () => new Map();

/** The person a legacy user id became: their user id, `pending` when the check expects a people file to add them, or null. */
type PersonLookup = (oldId: string) => string | 'pending' | null;

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
    private readonly retention: RetentionScan,
    private readonly identity: Pick<IdentityService, 'importMember' | 'forgetActors'>,
    private readonly members: Pick<MemberDirectory, 'accountByEmail'>,
    private readonly roleStore: Pick<RoleStore, 'roles'>,
  ) {
    jobs.register<Record<string, never>, { purged?: number }>('migration.purge', {
      label: 'Migration data clean-up',
      batchSize: PURGES_PER_BATCH,
      notice: () => null,
      run: async ({ ctx, state, batchSize }) => {
        const n = await this.purgeExpired(ctx, batchSize);
        const purged = (state.purged ?? 0) + n;
        return { state: { purged }, progress: purged, done: n < batchSize, result: { purged } };
      },
    });
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

  // ---------------------------------------------------------- attachments

  /**
   * Uploads one file for a file column to name, under a relative path (`photos/a.jpg`). It goes through
   * `FileService.upload`, so quota, content sniffing and the size limit apply, and the person uploading is
   * the only one who can link it. Answers the profile's totals. Adding one returns the profile to draft.
   */
  async addAttachment(ctx: TenantContext, id: string, body: UploadInput['body'], rawPath: string): Promise<{ count: number; bytes: number }> {
    const profile = await this.editable(ctx, id);
    const path = attachmentPath(rawPath);
    const lower = path.toLowerCase();
    await this.tm.withTenant(
      ctx.tenantId,
      async (tx) => {
        if ((await this.store.attachmentTotals(tx, profile.id)).count >= MIGRATION_MAX_ATTACHMENTS) throw tooMany();
        if ((await this.store.attachmentsByPath(tx, profile.id, [lower])).size) throw duplicatePath(path);
      },
      { readOnly: true },
    );
    const file = await this.files.upload(ctx, { body, name: path.slice(path.lastIndexOf('/') + 1) });
    try {
      return await this.tm.withTenant(ctx.tenantId, async (tx) => {
        const locked = await this.store.lockProfile(tx, profile.id);
        if (!locked) throw notFound('Migration not found.');
        if (locked.status === 'running') throw conflict('This migration is running. Wait for it to finish or cancel it.');
        if ((await this.store.attachmentTotals(tx, profile.id)).count >= MIGRATION_MAX_ATTACHMENTS) throw tooMany();
        if (!(await this.store.addAttachment(tx, { profileId: profile.id, path, fileId: file.id, size: file.size, uploadedBy: ctx.actor.id }))) throw duplicatePath(path);
        await this.store.reset(tx, profile.id);
        return this.store.attachmentTotals(tx, profile.id);
      });
    } catch (e) {
      await this.files.discardUnlinked(ctx.tenantId, [file.id]);
      throw e;
    }
  }

  /** The profile's attachments by path, filtered by `q` (a part of the path, any case). */
  async attachments(ctx: TenantContext, id: string, query: { q?: unknown; limit?: unknown; offset?: unknown } = {}): Promise<{ items: AttachmentItem[]; total: number }> {
    const profile = await this.load(ctx, id);
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 255) : '';
    const limit = Math.min(Math.max(Math.trunc(Number(query.limit ?? 50)) || 50, 1), 200);
    const offset = Math.max(Math.trunc(Number(query.offset ?? 0)) || 0, 0);
    return this.tm.withTenant(ctx.tenantId, (tx) => this.store.attachmentPage(tx, profile.id, { q, limit, offset }), { readOnly: true });
  }

  /** Removes one attachment and its stored file (a file already linked to a record stays with the record). */
  async removeAttachment(ctx: TenantContext, id: string, attachmentId: string): Promise<void> {
    const profile = await this.editable(ctx, id);
    const fileId = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const gone = UUID.test(attachmentId) ? await this.store.removeAttachment(tx, profile.id, attachmentId) : undefined;
      if (!gone) throw notFound('Attachment not found.');
      await this.store.reset(tx, profile.id);
      return gone;
    });
    await this.files.discardUnlinked(ctx.tenantId, [fileId]);
  }

  /** Removes every attachment of the profile. */
  async clearAttachments(ctx: TenantContext, id: string): Promise<void> {
    const profile = await this.editable(ctx, id);
    const fileIds = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const ids = await this.store.clearAttachments(tx, profile.id);
      if (ids.length) await this.store.reset(tx, profile.id);
      return ids;
    });
    await this.discard(ctx.tenantId, fileIds);
  }

  private async discard(tenantId: string, fileIds: string[]): Promise<void> {
    for (let i = 0; i < fileIds.length; i += KEY_CHUNK) await this.files.discardUnlinked(tenantId, fileIds.slice(i, i + KEY_CHUNK));
  }

  /**
   * Saves which record types a file fills and from which columns, or (`{ kind: 'people', people }`)
   * that its rows are people of the organisation (that needs `data:migrate:people` and
   * `members:manage`). When the file now looks up records another file writes later, the files are
   * reordered so it waits for that file.
   */
  async setMapping(ctx: TenantContext, id: string, sourceId: string, input: unknown): Promise<ProfileView> {
    const profile = await this.editable(ctx, id);
    const types = await this.types(ctx);
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const sources = await this.store.sources(tx, profile.id);
      const source = sources.find((s) => s.id === sourceId);
      if (!source) throw notFound('File not found.');
      const mapping = readSourceMapping(input, source.columns.map((c) => c.name), types, (await this.roleStore.roles(tx)).map((r) => r.key));
      if (isPeople(mapping)) demandPeople(ctx);
      for (const t of targetsOf(mapping)) demand(ctx.actor, `record:${t.type}:import`);
      const next = sources.map((s) => (s.id === source.id ? { ...s, mapping } : s));
      const ordered = deriveOrder(next.map(ordering), types);
      if (ordered.some((s, i) => s.id !== next[i]!.id)) await this.store.setOrder(tx, profile.id, ordered.map((s) => s.id));
      await this.store.saveMapping(tx, profile.id, source.id, mapping);
      // Redaction: samples of columns that fill sensitive or personal fields are blanked for good
      // (re-mapping later does not bring them back), and so are the failed-row cells of sensitive ones.
      const hiddenSamples = new Set(columnsFilling(mapping, source.columns, types, hidesSample));
      if (hiddenSamples.size) {
        await this.store.setColumns(tx, profile.id, source.id, source.columns.map((c, i) => (hiddenSamples.has(i) ? { ...c, samples: [] } : c)));
      }
      if (profile.job_id) await this.store.blankFailedCells(tx, profile.job_id, source.id, columnsFilling(mapping, source.columns, types, hidesCell));
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
    assertReadable(sources);
    const mapped = sources.filter((s) => s.mapping);
    if (!mapped.length) throw validationFailed('Match at least one file to a record type first.');
    checkOrder(sources.map(ordering), types);
    for (const s of mapped) {
      if (isPeople(s.mapping)) demandPeople(ctx);
      for (const t of targetsOf(s.mapping)) demand(ctx.actor, `record:${t.type}:import`);
    }

    const result: MigrationCheck = { rows: 0, ready: 0, invalid: 0, creates: 0, updates: 0, sources: [], problems: [], warnings: [], checkedAt: new Date().toISOString() };
    const guards = await typeGuards(this.defs, ctx.tenantId, types, mapped.flatMap((s) => targetsOf(s.mapping).map((t) => t.type)));
    const peopleEnv = mapped.some((s) => isPeople(s.mapping)) ? await this.personEnv(ctx) : null;
    const planned = new Map<string, Set<string>>();
    const plan = (typeKey: string, oldId: string) => {
      const set = planned.get(typeKey) ?? new Set<string>();
      planned.set(typeKey, set);
      set.add(oldId);
    };
    // Legacy user ids an earlier people file of this profile would add, as found as those already linked.
    const plannedPeople = new Set<string>();
    // Records are checked as a run saves them: a suspended member may fill a person field.
    const checkCtx: TenantContext = { ...ctx, migrating: true };
    const refs = new Map<string, Promise<string>>();
    // Attachment file id to the record (`type:old id`) an earlier row of this check will link it to; and the sizes still to link.
    const claimed = new Map<string, string>();
    const toLinkBytes = new Map<string, number>();
    for (const source of mapped) {
      const mapping = source.mapping!;
      const { rows } = await this.read(ctx, source.file_id);
      const at = columnIndex(source);
      if (isPeople(mapping)) {
        const checked = await this.checkPeople(ctx, source, mapping, rows, at, peopleEnv!, result, plannedPeople);
        result.sources.push(checked);
        result.rows += checked.rows;
        result.ready += checked.ready;
        result.invalid += checked.invalid;
        result.creates += checked.creates;
        result.updates += checked.updates;
        continue;
      }
      const known = await this.knownKeys(ctx, mapping, types, rows, at);
      const lookup: OldIdLookup = async (typeKey, oldId) => known.get(typeKey)?.get(oldId)?.recordId ?? (planned.get(typeKey)?.has(oldId) ? 'pending' : null);
      const counts: SourceCheck = { sourceId: source.id, fileName: source.file_name, rows: rows.length, ready: 0, invalid: 0, creates: 0, updates: 0 };
      const personCells = personColumns(mapping).map((c) => at.get(c) ?? -1);
      const linkedIds = personCells.length ? await this.linkedPeople(ctx, rows.flatMap((r) => personCells.map((i) => (r.cells[i] ?? '').trim())).filter(Boolean)) : new Map<string, LinkedPerson>();
      const person: PersonLookup = (oldId) => linkedIds.get(oldId)?.userId ?? (plannedPeople.has(oldId) ? 'pending' : null);
      // Distinct unresolved legacy user ids by person column, from rows that are ready.
      const unresolved = new Map<string, Set<string>>();
      // Attachments the file columns name, read for exactly those names; names no attachment has, by column, for rows that are ready.
      const attachments = await this.attachmentsNamed(ctx, profile.id, mapping, types, rows, at);
      const fileLookup: FileLookup = async (names) => new Map(names.flatMap((n) => (attachments.has(n) ? [[n, attachments.get(n)!] as const] : [])));
      const missingSkipped = new Map<string, Set<string>>();
      // Guards: reported once per file and target, not per row. A blocked type refuses its rows below.
      const blocked = new Set<string>();
      const warned = new Map<string, MigrationWarning>();
      for (const t of mapping.targets) {
        const guard = guards.get(t.type);
        if (!guard) continue;
        for (const message of guard.blocking) {
          blocked.add(t.type);
          if (result.problems.length < PROBLEMS_SHOWN) result.problems.push({ row: 0, message, sourceId: source.id, fileName: source.file_name, target: t.key, severity: 'error' });
        }
        for (const message of guard.warnings) {
          const w = warned.get('script-effects-suppressed') ?? { kind: 'script-effects-suppressed', sourceId: source.id, fileName: source.file_name, count: 0, samples: [] };
          warned.set(w.kind, w);
          w.count++;
          if (w.samples.length < WARNING_SAMPLES && !w.samples.includes(message)) w.samples.push(message);
        }
      }
      result.warnings.push(...warned.values());
      for (const r of rows) {
        const written = new Map<string, string>();
        const rowProblems: MigrationProblem[] = [];
        let creates = 0;
        let updates = 0;
        const toPlan: [string, string][] = [];
        const rowUnresolved: { column: string; oldId: string }[] = [];
        const rowSkipped: { column: string; name: string }[] = [];
        // Files this row's targets take, by file id to the record they are for; added to the profile-wide claims once the row is ready.
        const rowClaims = new Map<string, { key: string; size: number; free: boolean }>();
        let guarded = false;
        for (const t of mapping.targets) {
          const type = types.get(t.type)!;
          if (blocked.has(t.type)) {
            // Already reported above; a required target fails the row, an optional one is left out.
            if (t.required) {
              guarded = true;
              break;
            }
            continue;
          }
          const p = await this.prepare(ctx, type, t, at, r, refs, lookup, written, person, fileLookup);
          const tag = (problems: CellProblem[]) => problems.map((x) => ({ ...x, sourceId: source.id, fileName: source.file_name, target: t.key }));
          if (p.blank) {
            if (!t.required) continue;
            rowProblems.push(...tag([blankOldId(r.row, t)]));
            break;
          }
          let problems = p.problems;
          const existing = known.get(t.type)?.get(p.oldId);
          const recordKey = `${t.type}:${p.oldId}`;
          if (!problems.length && p.attached.length) {
            // One attachment links once: a file a record holds, or an earlier row of this check takes, is refused.
            const taken = (a: Prepared['attached'][number]) => {
              const by = claimed.get(a.fileId) ?? rowClaims.get(a.fileId)?.key;
              return by !== undefined && by !== recordKey;
            };
            problems = [
              ...heldElsewhere(p, r.row, existing?.recordId),
              ...p.attached.filter((a) => a.recordId === null && taken(a)).map((a) => ({ row: r.row, column: a.column, field: a.field, message: `File '${a.name}' is used by another row` })),
            ];
          }
          if (!problems.length) {
            try {
              await this.records.check(checkCtx, t.type, { data: p.data, ...(existing ? { id: existing.recordId } : {}) });
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
          rowUnresolved.push(...p.unresolved);
          rowSkipped.push(...p.skippedFiles);
          for (const a of p.attached) rowClaims.set(a.fileId, { key: recordKey, size: a.size, free: a.recordId === null });
          toPlan.push([t.type, p.oldId]);
          written.set(t.key, existing?.recordId ?? 'pending');
          if (existing) updates++;
          else creates++;
        }
        if (guarded || rowProblems.length) {
          counts.invalid++;
          for (const x of rowProblems) if (result.problems.length < PROBLEMS_SHOWN) result.problems.push(x);
          continue;
        }
        for (const [typeKey, oldId] of toPlan) plan(typeKey, oldId);
        for (const u of rowUnresolved) unresolved.set(u.column, (unresolved.get(u.column) ?? new Set<string>()).add(u.oldId));
        for (const s of rowSkipped) missingSkipped.set(s.column, (missingSkipped.get(s.column) ?? new Set<string>()).add(s.name));
        for (const [fileId, c] of rowClaims) {
          claimed.set(fileId, c.key);
          if (c.free) toLinkBytes.set(fileId, c.size);
        }
        counts.ready++;
        counts.creates += creates;
        counts.updates += updates;
      }
      for (const [column, ids] of unresolved) {
        result.warnings.push({ kind: 'unresolved-legacy-users', sourceId: source.id, fileName: source.file_name, column, count: ids.size, samples: [...ids].slice(0, WARNING_SAMPLES) });
      }
      for (const [column, names] of missingSkipped) {
        result.warnings.push({ kind: 'missing-attachments', sourceId: source.id, fileName: source.file_name, column, count: names.size, samples: [...names].slice(0, WARNING_SAMPLES) });
      }
      result.sources.push(counts);
      result.rows += counts.rows;
      result.ready += counts.ready;
      result.invalid += counts.invalid;
      result.creates += counts.creates;
      result.updates += counts.updates;
    }
    if (toLinkBytes.size) {
      // Uploads count against the quota from the moment they are stored, so linking adds nothing; say so when the organisation is over its limit anyway.
      const { used, quota } = await this.files.usageOf(ctx.tenantId);
      const bytes = [...toLinkBytes.values()].reduce((n, b) => n + b, 0);
      if (used > quota) {
        result.warnings.push({
          kind: 'storage-over-quota',
          sourceId: null,
          fileName: null,
          count: toLinkBytes.size,
          samples: [`${toLinkBytes.size} attachments (${bytes} bytes) are still to link; the organisation uses ${used} of ${quota} bytes of file storage, so new uploads are refused until files are removed`],
        });
      }
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
    assertReadable(sources);
    for (const s of sources) {
      if (isPeople(s.mapping)) demandPeople(ctx);
      for (const t of targetsOf(s.mapping)) demand(ctx.actor, `record:${t.type}:import`);
    }
    // The guards are read again: a rule published since the check must not slip through.
    const guards = await typeGuards(this.defs, ctx.tenantId, await this.types(ctx), sources.flatMap((s) => targetsOf(s.mapping).map((t) => t.type)));
    const stop = [...guards.values()].flatMap((g) => g.blocking)[0];
    if (stop) throw conflict(`This migration cannot run: ${stop} Check it again.`);
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

  // --------------------------------------------------------------- purge

  /**
   * Deletes what a migration keeps of the old system's data: the source CSVs (soft-deleted file
   * rows and stored bytes), the column samples and the cells of failed rows. The profile, its
   * mappings, counts and reasons stay, and every purged file and the profile get `purged_at`.
   *
   * Rule after a purge: a profile with a purged file cannot be checked or run (`assertReadable`),
   * so the administrator removes the purged files and uploads them again; the new files are
   * ordinary. A purged file's failed rows cannot be downloaded. Repeating a purge does nothing
   * more than purge files uploaded since. A running profile is refused, like any edit.
   */
  async purge(ctx: TenantContext, id: string): Promise<ProfileView> {
    const profile = await this.editable(ctx, id);
    await this.purgeProfile(ctx, profile, 'requested');
    return this.get(ctx, profile.id);
  }

  /** Organisations with migrations due for the automatic purge, for the scheduler. */
  tenantsWithExpiredData(): Promise<string[]> {
    return this.retention.tenantsWithExpiredMigrations(MIGRATION_RETENTION_DAYS);
  }

  /** Purges up to `limit` of the organisation's finished or failed migrations older than the retention time. */
  private async purgeExpired(ctx: TenantContext, limit: number): Promise<number> {
    const due = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.expiredProfiles(tx, MIGRATION_RETENTION_DAYS, limit), { readOnly: true });
    for (const p of due) await this.purgeProfile(ctx, p, 'retention');
    return due.length;
  }

  private async purgeProfile(ctx: TenantContext, profile: ProfileRow, reason: 'requested' | 'retention'): Promise<void> {
    const sources = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.sources(tx, profile.id));
    const live = sources.filter((s) => !s.purged_at);
    // Files first: it is repeatable, so a failure before the rows are stamped is retried by the next purge.
    await this.files.discardUnlinked(ctx.tenantId, live.map((s) => s.file_id));
    // The attachments too: unlinked ones are deleted with their bytes, ones a record holds stay with the record.
    const attachmentFiles = await this.tm.withTenant(ctx.tenantId, (tx) => this.store.attachmentFileIds(tx, profile.id), { readOnly: true });
    await this.discard(ctx.tenantId, attachmentFiles);
    for (const s of sources) this.parsed.delete(s.file_id);
    await this.tm.withTenant(ctx.tenantId, async (tx) => {
      const locked = await this.store.lockProfile(tx, profile.id);
      if (!locked) throw notFound('Migration not found.');
      if (locked.status === 'running') throw conflict('This migration is running. Wait for it to finish or cancel it.');
      for (const s of live) await this.store.markSourcePurged(tx, profile.id, s.id, s.columns.map((c) => ({ ...c, samples: [] })));
      if (locked.job_id) await this.store.clearFailedCells(tx, locked.job_id);
      const attachments = (await this.store.clearAttachments(tx, profile.id)).length;
      if (locked.status === 'checked') await this.store.reset(tx, profile.id);
      const first = await this.store.markProfilePurged(tx, profile.id);
      if (first || live.length || attachments) {
        await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'migration.purged', entity: 'migration', entityId: profile.id, after: { reason, files: live.length, attachments } });
      }
    });
  }

  /** One file's rows that failed in the last run, as they were in the file, with the reason last. */
  async *failedCsv(ctx: TenantContext, id: string, sourceId: string): AsyncGenerator<string> {
    const profile = await this.load(ctx, id);
    if (!profile.job_id) throw conflict('This migration has not run yet.');
    const source = (await this.tm.withTenant(ctx.tenantId, (tx) => this.store.sources(tx, profile.id))).find((s) => s.id === sourceId);
    if (!source) throw notFound('File not found.');
    if (source.purged_at) throw conflict('The failed rows of this file were deleted when the migration data was purged.');
    await this.tm.withTenant(ctx.tenantId, (tx) =>
      this.audit.audit(tx, {
        actorId: ctx.actor.id,
        action: 'migration.failed_rows_downloaded',
        entity: 'migration',
        entityId: profile.id,
        after: { sourceId: source.id, fileName: source.file_name },
      }),
    );
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
    const saveCtx: TenantContext = { ...ctx, quiet: true, migrating: true, deferredRollups: deferred };
    const refs = new Map<string, Promise<string>>();
    const items: JobItemResult[] = [];
    const batch = rows.slice(next, next + batchSize);
    if (isPeople(source.mapping)) {
      // The creator's access is read again every batch (the job runs with their current roles).
      if (!can(ctx.actor, MIGRATE_PEOPLE) || !can(ctx.actor, MEMBERS_MANAGE)) {
        throw new PlatformError('forbidden', 'You no longer have permission to add people (Data migration: people and Manage people). The migration was stopped; people already added stay.');
      }
      const spec = source.mapping.people;
      const env = await this.personEnv(ctx);
      const known = await this.linkedPeople(ctx, batch.map((r) => (r.cells[at.get(spec.oldId) ?? -1] ?? '').trim()).filter(Boolean));
      for (const [i, r] of batch.entries()) {
        const seq = index * SEQ_PER_SOURCE + next + i + 1;
        items.push(await this.runPersonRow(ctx, profile.id, source, spec, at, r, env, known, seq));
      }
      // Each membership and role insert bumped the organisation's access version; this instance forgets its cached people once.
      this.identity.forgetActors();
    } else {
      // The legacy user ids of this batch's person columns are looked up once (this organisation's links only).
      const personCells = personColumns(source.mapping).map((c) => at.get(c) ?? -1);
      const people = personCells.length ? await this.linkedPeople(ctx, batch.flatMap((r) => personCells.map((i) => (r.cells[i] ?? '').trim())).filter(Boolean)) : new Map<string, LinkedPerson>();
      for (const [i, r] of batch.entries()) {
        const seq = index * SEQ_PER_SOURCE + next + i + 1;
        items.push(await this.runRow(ctx, saveCtx, profile.id, source, source.mapping, types, at, r, refs, people, seq));
      }
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
    mapping: RecordsMapping,
    types: TypesByKey,
    at: Map<string, number>,
    r: CsvRow,
    refs: Map<string, Promise<string>>,
    people: ReadonlyMap<string, LinkedPerson>,
    seq: number,
  ): Promise<JobItemResult> {
    try {
      const out = await this.records.saveTogether(saveCtx, async (rs, tx) => {
        const written = new Map<string, string>();
        const lookup: OldIdLookup = async (typeKey, oldId) => (await this.store.keys(tx, typeKey, [oldId])).get(oldId)?.recordId ?? null;
        const person: PersonLookup = (oldId) => people.get(oldId)?.userId ?? null;
        let warned = 0;
        let created = 0;
        let updated = 0;
        let first: string | undefined;
        const skipped: string[] = [];
        for (const t of mapping.targets) {
          const type = types.get(t.type);
          if (!type) throw new RowFailure([{ row: r.row, message: `Record type '${t.type}' no longer exists.` }]);
          const p = await this.prepare(ctx, type, t, at, r, refs, lookup, written, person, (names) => this.store.attachmentsByPath(tx, profileId, names));
          if (p.blank || p.problems.length) {
            if (t.required) throw new RowFailure(p.blank ? [blankOldId(r.row, t)] : p.problems);
            skipped.push(t.key);
            continue;
          }
          const existing = (await this.store.keys(tx, t.type, [p.oldId])).get(p.oldId);
          // One attachment links once: a file another record holds is refused here, in plain words.
          const held = heldElsewhere(p, r.row, existing?.recordId);
          if (held.length) {
            if (t.required) throw new RowFailure(held);
            skipped.push(t.key);
            continue;
          }
          if (p.unresolved.length || p.skippedFiles.length) warned = 1;
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
        return { created, updated, first, skipped, warned };
      });
      return {
        seq,
        status: 'done',
        ...(out.first ? { recordId: out.first } : {}),
        data: { sourceId: source.id, created: out.created, updated: out.updated, ...(out.skipped.length ? { skipped: out.skipped } : {}), ...(out.warned ? { warned: out.warned } : {}) },
      };
    } catch (e) {
      // Cells of columns that fill sensitive fields are stored empty; the rest is kept for failed.csv.
      const blank = new Set(columnsFilling(mapping, source.columns, types, hidesCell));
      const cells = blank.size ? r.cells.map((c, i) => (blank.has(i) ? '' : c)) : r.cells;
      if (e instanceof RowFailure) return { seq, status: 'failed', message: reasonOf(e.problems), data: { sourceId: source.id, cells } };
      if (e instanceof PlatformError) return { seq, status: 'failed', message: e.message, data: { sourceId: source.id, cells } };
      throw e;
    }
  }

  private notice(job: JobView) {
    const r = job.result as { profileId?: string; created?: number; updated?: number; failed?: number; warned?: number; booksError?: string } | null;
    if (job.status !== 'done' || !r?.profileId) {
      return { subject: job.status === 'cancelled' ? 'Data migration cancelled' : 'Data migration failed', body: job.error ? `Data migration stopped: ${job.error}.` : 'Data migration stopped.' };
    }
    const books = r.booksError ? ` The books were not applied: ${r.booksError}` : '';
    return {
      subject: 'Data migration finished',
      body: `Data migration finished: ${r.created ?? 0} records created, ${r.updated ?? 0} updated, ${r.failed ?? 0} rows failed.${r.warned ? ` ${r.warned} rows have warnings.` : ''}${books}`,
      link: `/admin/migration/${r.profileId}/result`,
    };
  }

  // ------------------------------------------------------------- helpers

  // --------------------------------------------------------------- people

  /** What the organisation's roles allow the person migrating, and the languages it offers. */
  private async personEnv(ctx: TenantContext): Promise<PersonEnv> {
    const roles = await this.tm.withTenant(ctx.tenantId, (tx) => this.roleStore.roles(tx), { readOnly: true });
    const own = (await this.defs.list(ctx.tenantId, 'translation')).map((t) => (t.body as { locale?: string }).locale).filter((l): l is string => typeof l === 'string');
    const rules = new Map<string, RoleRule>(roles.map((r) => [r.key, { requireTwoStep: r.requireTwoStep, grantable: mayGrant(ctx.actor, r.permissions) }]));
    return { roles: rules, locales: new Set<string>([...SHIPPED_LOCALES, ...own]) };
  }

  /** The people the given legacy user ids already stand for in this organisation. */
  private async linkedPeople(ctx: TenantContext, oldIds: string[]): Promise<Map<string, LinkedPerson>> {
    const all = [...new Set(oldIds)];
    return this.tm.withTenant(
      ctx.tenantId,
      async (tx) => {
        const out = new Map<string, LinkedPerson>();
        for (let i = 0; i < all.length; i += KEY_CHUNK) for (const [k, v] of await this.store.personKeys(tx, all.slice(i, i + KEY_CHUNK))) out.set(k, v);
        return out;
      },
      { readOnly: true },
    );
  }

  /**
   * One person of a people file. The legacy id is looked up first, so a changed email never creates a
   * stray account. A reused account in any organisation is silent: only a globally disabled account that
   * is not a member here is refused, with the generic wording. Account and membership are two
   * transactions; if the process stops between them the account stays unseen and the next run converges.
   */
  private async runPersonRow(
    ctx: TenantContext,
    profileId: string,
    source: SourceRow,
    spec: PeopleMapping['people'],
    at: Map<string, number>,
    r: CsvRow,
    env: PersonEnv,
    known: Map<string, LinkedPerson>,
    seq: number,
  ): Promise<JobItemResult> {
    const failed = (message: string): JobItemResult => ({ seq, status: 'failed', message, data: { sourceId: source.id, cells: r.cells } });
    const { person, problems } = readPersonRow(spec, (column) => (r.cells[at.get(column) ?? -1] ?? '').trim(), env);
    if (!person) return failed(problems.map((p) => p.message).join('; '));
    try {
      const linked = known.get(person.oldId);
      let update = true;
      if (linked) {
        if (linked.email !== person.email) return failed(LINKED_ELSEWHERE);
      } else {
        const account = await this.members.accountByEmail(ctx.tenantId, person.email);
        if (account?.member_status === null && account.status !== 'active') return failed(CANNOT_ADD);
        // Already a member and not migrated: linked and left alone.
        if (account && account.member_status !== null) update = false;
      }
      const saved = await this.identity.importMember(
        ctx,
        { email: person.email, displayName: person.name, roles: person.roles, status: person.status, locale: person.locale, ...(linked ? { userId: linked.userId } : {}), update },
        (tx, userId) => this.store.putPersonKey(tx, { oldId: person.oldId, userId, profileId }),
      );
      known.set(person.oldId, { userId: saved.userId, email: person.email });
      const here = !!linked || !saved.created;
      const warned = saved.status === 'suspended' && person.roles.length ? 1 : 0;
      return { seq, status: 'done', data: { sourceId: source.id, created: here ? 0 : 1, updated: here ? 1 : 0, ...(warned ? { warned } : {}) } };
    } catch (e) {
      if (e instanceof PlatformError) return failed(e.message);
      throw e;
    }
  }

  /** A people file's rows through the same rules as a run, from this organisation's own data only. */
  private async checkPeople(
    ctx: TenantContext,
    source: SourceRow,
    mapping: PeopleMapping,
    rows: CsvRow[],
    at: Map<string, number>,
    env: PersonEnv,
    result: MigrationCheck,
    planned: Set<string>,
  ): Promise<SourceCheck> {
    const spec = mapping.people;
    const counts: SourceCheck = { sourceId: source.id, fileName: source.file_name, rows: rows.length, ready: 0, invalid: 0, creates: 0, updates: 0 };
    const read = rows.map((r) => ({ r, ...readPersonRow(spec, (column) => (r.cells[at.get(column) ?? -1] ?? '').trim(), env) }));
    const valid = read.flatMap((x) => (x.person ? [x.person] : []));
    const linked = await this.linkedPeople(ctx, valid.map((p) => p.oldId));
    const emails = [...new Set(valid.map((p) => p.email))];
    const members = await this.tm.withTenant(
      ctx.tenantId,
      async (tx) => {
        const out = new Set<string>();
        for (let i = 0; i < emails.length; i += KEY_CHUNK) for (const e of await this.store.memberEmails(tx, emails.slice(i, i + KEY_CHUNK))) out.add(e);
        return out;
      },
      { readOnly: true },
    );

    const emailOfOldId = new Map<string, string>();
    const oldIdsOfEmail = new Map<string, Set<string>>();
    const seenOldIds = new Set<string>();
    let alreadyMembers = 0;
    const suspendedWithRoles: string[] = [];
    for (const { r, person, problems } of read) {
      const found: { column?: string; message: string }[] = [...problems];
      if (person) {
        const first = emailOfOldId.get(person.oldId);
        if (first !== undefined && first !== person.email) found.push({ column: spec.email, message: `Legacy id '${person.oldId}' appears with two different emails in this file` });
        else emailOfOldId.set(person.oldId, person.email);
        const link = linked.get(person.oldId);
        if (link && link.email !== person.email) found.push({ column: spec.email, message: LINKED_ELSEWHERE });
      }
      if (found.length || !person) {
        counts.invalid++;
        for (const p of found) if (result.problems.length < PROBLEMS_SHOWN) result.problems.push({ row: r.row, ...(p.column ? { column: p.column } : {}), message: p.message, sourceId: source.id, fileName: source.file_name, severity: 'error' });
        continue;
      }
      counts.ready++;
      planned.add(person.oldId);
      const isLinked = linked.has(person.oldId);
      const isMember = members.has(person.email);
      if (isMember && !isLinked && !seenOldIds.has(person.oldId)) alreadyMembers++;
      // Something already here, or an earlier row of this file, makes this row an update.
      const exists = isLinked || isMember || seenOldIds.has(person.oldId) || (oldIdsOfEmail.get(person.email)?.size ?? 0) > 0;
      if (exists) counts.updates++;
      else counts.creates++;
      seenOldIds.add(person.oldId);
      const ids = oldIdsOfEmail.get(person.email) ?? new Set<string>();
      oldIdsOfEmail.set(person.email, ids);
      ids.add(person.oldId);
      if (person.status === 'suspended' && person.roles.length) suspendedWithRoles.push(person.oldId);
    }

    const warn = (kind: string, count: number, samples: string[]) => {
      if (count > 0) result.warnings.push({ kind, sourceId: source.id, fileName: source.file_name, count, samples: samples.slice(0, WARNING_SAMPLES) });
    };
    warn('already-members', alreadyMembers, [`${alreadyMembers} already members of this organisation, will be linked and not changed`]);
    const shared = [...oldIdsOfEmail.values()].filter((ids) => ids.size > 1);
    warn('duplicate-email', shared.length, shared.map((ids) => `Legacy ids ${[...ids].slice(0, 4).join(', ')} share one email; they will be one person`));
    warn('roles-skipped-suspended', suspendedWithRoles.length, suspendedWithRoles.map((id) => `Legacy id ${id} is suspended, so its roles are skipped`));
    return counts;
  }
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
    person: PersonLookup = () => null,
    files: FileLookup = noFiles,
  ): Promise<Prepared> {
    const cell = (column: string) => (r.cells[at.get(column) ?? -1] ?? '').trim();
    const oldId = cell(t.oldId);
    const out: Prepared = { blank: oldId === '', oldId, data: {}, problems: [], columnOf: new Map(), pending: new Set(), unresolved: [], attached: [], skippedFiles: [] };
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
    for (const [fieldKey, p] of Object.entries(t.persons ?? {})) {
      const f = type.fields.find((x) => x.key === fieldKey);
      if (!f) continue;
      out.columnOf.set(f.key, p.column);
      const raw = cell(p.column);
      if (raw === '') continue;
      const found = person(raw);
      if (found === 'pending') {
        out.pending.add(f.key);
        continue;
      }
      if (found) out.data[f.key] = found;
      else if (p.onMissing === 'fail') out.problems.push({ row: r.row, column: p.column, field: f.key, message: `${f.label}: no person was loaded with legacy user id '${raw}'` });
      else out.unresolved.push({ column: p.column, oldId: raw });
    }
    for (const [fieldKey, m] of Object.entries(t.files ?? {})) {
      const f = type.fields.find((x) => x.key === fieldKey);
      if (!f) continue;
      out.columnOf.set(f.key, m.column);
      const raw = cell(m.column);
      if (raw === '') continue;
      const names = fileNames(raw, f, m);
      const found = await files(names.map((n) => n.toLowerCase()));
      const ids: string[] = [];
      for (const name of names) {
        const a = found.get(name.toLowerCase());
        const bad = (message: string) => out.problems.push({ row: r.row, column: m.column, field: f.key, message });
        if (!a) {
          if (m.onMissing === 'skip') out.skippedFiles.push({ column: m.column, name });
          else bad(`File '${name}' was not uploaded`);
          continue;
        }
        // A file a record already holds was checked when it was linked; one still free must fit this field.
        if (!a.recordId) {
          const kind = kindOfMime(a.mime);
          if (a.uploadedBy !== ctx.actor.id) {
            bad(`File '${name}' was uploaded by another person; upload again`);
            continue;
          }
          if (f.accept?.length && (!kind || !f.accept.includes(kind))) {
            bad(`${f.label} accepts only ${f.accept.join(', ')} files`);
            continue;
          }
          if (f.maxSizeMb && a.size > f.maxSizeMb * MB) {
            bad(`${f.label} accepts files of at most ${f.maxSizeMb} MB`);
            continue;
          }
        }
        ids.push(a.fileId);
        out.attached.push({ fileId: a.fileId, size: a.size, recordId: a.recordId, name, column: m.column, field: f.key });
      }
      if (ids.length) out.data[f.key] = f.multiple ? ids : ids[0];
    }
    return out;
  }

  /** The attachments a file's file columns name (only those), by lowercased path. Reads names, never contents. */
  private async attachmentsNamed(ctx: TenantContext, profileId: string, mapping: RecordsMapping, types: TypesByKey, rows: CsvRow[], at: Map<string, number>): Promise<Map<string, AttachmentInfo>> {
    const wanted = new Set<string>();
    for (const t of mapping.targets) {
      for (const [fieldKey, m] of Object.entries(t.files ?? {})) {
        const f = types.get(t.type)?.fields.find((x) => x.key === fieldKey);
        const i = at.get(m.column);
        if (!f || i === undefined) continue;
        for (const r of rows) for (const n of fileNames((r.cells[i] ?? '').trim(), f, m)) wanted.add(n.toLowerCase());
      }
    }
    const all = [...wanted];
    return this.tm.withTenant(
      ctx.tenantId,
      async (tx) => {
        const out = new Map<string, AttachmentInfo>();
        for (let i = 0; i < all.length; i += KEY_CHUNK) for (const [k, v] of await this.store.attachmentsByPath(tx, profileId, all.slice(i, i + KEY_CHUNK))) out.set(k, v);
        return out;
      },
      { readOnly: true },
    );
  }

  /** The records already loaded for the old ids a file names, by record type. */
  private async knownKeys(
    ctx: TenantContext,
    mapping: RecordsMapping,
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
            kind: isPeople(s.mapping) ? 'people' : 'records',
            mapping: s.mapping,
            purgedAt: s.purged_at ? iso(s.purged_at) : null,
            counts: counts ? (counts.get(s.id) ?? (s.mapping ? { created: 0, updated: 0, failed: 0 } : null)) : null,
          })),
          books: row.books ?? {},
          booksAppliedAt: row.books_applied_at ? iso(row.books_applied_at) : null,
          booksResult: row.books_result,
          check: row.check_result ? { ...row.check_result, warnings: row.check_result.warnings ?? [] } : null,
          jobId: row.job_id,
          purgedAt: row.purged_at ? iso(row.purged_at) : null,
          attachments: await this.store.attachmentTotals(tx, row.id),
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        };
      },
      { readOnly: true },
    );
  }
}

/** The names in a file cell: the whole cell for a field of one file, else split by the separator; trimmed, no blanks, each once ignoring case. */
function fileNames(raw: string, f: FieldDef, m: { separator?: string }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of f.multiple ? raw.split(m.separator ?? ';') : [raw]) {
    const name = part.trim().replace(/\\/g, '/');
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

/** Problems for attachments a record other than the one being written already holds (one attachment links once). */
function heldElsewhere(p: Prepared, row: number, existingId: string | undefined): CellProblem[] {
  return p.attached
    .filter((a) => a.recordId !== null && a.recordId !== existingId)
    .map((a) => ({ row, column: a.column, field: a.field, message: `File '${a.name}' is used by another row` }));
}

/** An attachment's relative path as stored: slashes forward, at most 255 characters, no `..` part, not absolute. */
function attachmentPath(raw: string): string {
  const path = raw.replace(/\\/g, '/').trim();
  const refuse = (message: string) => validationFailed(message, [{ path: '/x-file-name', message }]);
  if (!path) throw refuse('Name the file with its path (the x-file-name header).');
  if (path.length > MIGRATION_MAX_PATH) throw refuse(`The path is longer than ${MIGRATION_MAX_PATH} characters.`);
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) throw refuse('The path must be relative, such as photos/a.jpg.');
  if (path.split('/').includes('..')) throw refuse("The path cannot contain '..'.");
  if (/[\u0000-\u001f]/.test(path)) throw refuse('The path has characters that cannot be used.');
  if (path.endsWith('/')) throw refuse('The path must end with a file name.');
  return path;
}

const tooMany = () => validationFailed(`A migration can hold at most ${MIGRATION_MAX_ATTACHMENTS} attachments.`);
const duplicatePath = (path: string) => conflict(`This migration already has an attachment at ${path} (paths are compared ignoring case). Remove it first to replace it.`);

/** A purged file is gone from the store, so the migration cannot be checked or run until it is uploaded again. */
function assertReadable(sources: readonly SourceRow[]): void {
  const gone = sources.find((s) => s.purged_at);
  if (gone) throw conflict(`The file ${gone.file_name} was deleted when the migration data was purged. Remove it and upload it again to check or run this migration.`);
}

/** A people file needs both permissions: the migration one, and the one that creating people needs anywhere. */
function demandPeople(ctx: TenantContext): void {
  demand(ctx.actor, MIGRATE_PEOPLE);
  demand(ctx.actor, MEMBERS_MANAGE);
}

const ordering = (s: SourceRow): OrderedSource => ({ id: s.id, fileName: s.file_name, mapping: s.mapping });

/** Samples are hidden for sensitive and personal fields (a person field always counts as personal). */
const hidesSample = (f: FieldDef) => f.sensitive === true || f.personal === true || f.type === 'person';
/** Failed-row cells are hidden for sensitive fields only; the rest is how `failed.csv` lets an administrator fix the file. */
const hidesCell = (f: FieldDef) => f.sensitive === true;

/** Positions of the file's columns that fill a field for which `hides` is true. */
function columnsFilling(mapping: SourceMapping, columns: readonly MigrationColumn[], types: TypesByKey, hides: (f: FieldDef) => boolean): number[] {
  const out = new Set<number>();
  if (isPeople(mapping)) {
    // Names, emails and legacy ids are personal: their samples are hidden. Failed-row cells stay, as failed.csv needs them.
    if (hides !== hidesSample) return [];
    const { oldId, email, name } = mapping.people;
    return [oldId, email, name].map((n) => columns.findIndex((c) => c.name === n)).filter((i) => i >= 0);
  }
  for (const t of mapping.targets) {
    const fields = types.get(t.type)?.fields ?? [];
    for (const [fieldKey, column] of Object.entries(t.fields)) {
      const f = fields.find((x) => x.key === fieldKey);
      const at = columns.findIndex((c) => c.name === column);
      if (f && at >= 0 && hides(f)) out.add(at);
    }
    for (const [fieldKey, p] of Object.entries(t.persons ?? {})) {
      const f = fields.find((x) => x.key === fieldKey);
      const at = columns.findIndex((c) => c.name === p.column);
      if (f && at >= 0 && hides(f)) out.add(at);
    }
    for (const [fieldKey, m] of Object.entries(t.files ?? {})) {
      const f = fields.find((x) => x.key === fieldKey);
      const at = columns.findIndex((c) => c.name === m.column);
      if (f && at >= 0 && hides(f)) out.add(at);
    }
  }
  return [...out];
}

/** The columns of a records file that hold legacy user ids. */
function personColumns(mapping: SourceMapping): string[] {
  return [...new Set(targetsOf(mapping).flatMap((t) => Object.values(t.persons ?? {}).map((p) => p.column)))];
}

const columnIndex = (s: SourceRow) => new Map(s.columns.map((c, i) => [c.name, i]));

const blankOldId = (row: number, t: MigrationTarget): CellProblem => ({ row, column: t.oldId, message: `${t.oldId} is empty; every row needs an old id` });

function sumCounts(counts: Map<string, SourceCounts>): SourceCounts {
  const out = { created: 0, updated: 0, failed: 0, warned: 0 };
  for (const c of counts.values()) {
    out.created += c.created;
    out.updated += c.updated;
    out.failed += c.failed;
    out.warned += c.warned ?? 0;
  }
  return out;
}
