import { Readable } from 'node:stream';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { notFound } from '@onengo/kernel/errors';
import type { JobRunner } from '../../runtime/records/ports/job-runner.js';
import { demand } from '../../domain/permissions.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import { MASK } from '../../runtime/definitions/field-permissions.js';
import type { FieldDef, RecordTypeDef } from '../../runtime/definitions/types.js';
import { richTextToPlain } from '../../runtime/records/rich-text.js';
import type { FileService } from '../files/file-service.js';
import type { RecordQuery, RecordService, RecordView } from '../../runtime/records/record-service.js';
import type { CsvCodec } from './ports/csv-codec.js';

export const EXPORT_INLINE_ROWS = 50_000;
const PAGE = 1000;

interface ExportInput {
  recordType: string;
  query: RecordQuery;
}

interface ExportState {
  offset?: number;
  parts?: number;
  /** The store the parts are written to, chosen when the first part is written. */
  storeRef?: string;
}

/** Labels for the values of one page of records: choices, states, referenced records and files. */
interface Lookups {
  states: Map<string, string>;
  references: Map<string, Map<string, string>>;
  files: Map<string, string>;
}

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/**
 * CSV export of a record list: the same query, visibility and masking as the
 * list. Up to the inline limit the CSV streams back at once; above it an
 * `export` job writes a file the person downloads when it is done.
 */
export class ExportService {
  constructor(
    private readonly tm: TransactionManager,
    private readonly defs: DefinitionReader,
    private readonly records: RecordService,
    private readonly files: FileService,
    private readonly jobs: JobRunner,
    private readonly csv: CsvCodec,
    private readonly audit: AuditTrail,
    private readonly inlineRows = EXPORT_INLINE_ROWS,
  ) {
    jobs.register<ExportInput, ExportState>('export', {
      label: 'Export',
      batchSize: PAGE,
      requires: (input) => `record:${input.recordType}:export`,
      run: (job) => this.runBatch(job.ctx, job.jobId, job.input, job.state, job.batchSize),
      notice: (job) => {
        const r = job.result as { fileId?: string; rows?: number } | null;
        if (job.status !== 'done' || !r?.fileId) return { subject: 'Export failed', body: job.error ? `Export stopped: ${job.error}.` : 'Export stopped.' };
        return { subject: 'Export ready', body: `Your export of ${r.rows ?? 0} records is ready to download.`, link: `/api/files/${r.fileId}` };
      },
    });
  }

  /** The CSV lines, or the job that writes them when there are more rows than the inline limit. */
  async start(ctx: TenantContext, typeKey: string, query: RecordQuery): Promise<{ jobId: string } | { fileName: string; lines: AsyncIterable<string> }> {
    demand(ctx.actor, `record:${typeKey}:export`);
    const { query: c, total } = await this.count(ctx, typeKey, query);
    await this.tm.withTenant(ctx.tenantId, (tx) =>
      this.audit.audit(tx, { actorId: ctx.actor.id, action: 'records.exported', entity: `record:${typeKey}`, after: { query: c, rows: total } }),
    );
    if (total > this.inlineRows) {
      const job = await this.jobs.create(ctx, 'export', { recordType: typeKey, query: c }, total);
      return { jobId: job.id };
    }
    const type = await this.typeOf(ctx, typeKey);
    return { fileName: this.fileName(type), lines: this.lines(ctx, type, c, this.inlineRows) };
  }

  private async count(ctx: TenantContext, typeKey: string, query: RecordQuery): Promise<{ query: RecordQuery; total: number }> {
    const { limit: _l, offset: _o, sum: _s, withTotal: _w, ...c } = query;
    const { total } = await this.records.query(ctx, typeKey, { ...c, limit: 1, withTotal: true });
    return { query: c, total };
  }

  private async *lines(ctx: TenantContext, type: RecordTypeDef, query: RecordQuery, cap: number): AsyncGenerator<string> {
    const columns = await this.columns(ctx, type);
    yield `\uFEFF${this.csv.csvLine(columns.map((c) => c.label))}`;
    for (let offset = 0; offset < cap; ) {
      const { items } = await this.records.exportPage(ctx, type.key, query, offset, Math.min(PAGE, cap - offset));
      yield* await this.rows(ctx, type, columns, items);
      if (items.length < PAGE) return;
      offset += items.length;
    }
  }

  private async runBatch(ctx: TenantContext, jobId: string, input: ExportInput, state: ExportState, batchSize: number) {
    const type = await this.typeOf(ctx, input.recordType);
    const offset = state.offset ?? 0;
    const parts = state.parts ?? 0;
    const columns = await this.columns(ctx, type);
    const { items } = await this.records.exportPage(ctx, type.key, input.query, offset, batchSize);
    const text = [...(offset === 0 ? [`\uFEFF${this.csv.csvLine(columns.map((c) => c.label))}`] : []), ...(await this.rows(ctx, type, columns, items))].join('');
    const key = (n: number) => `${ctx.tenantId}/export-${jobId}-${n}`;
    const storeRef = state.storeRef ?? (await this.files.stores.forTenant(ctx.tenantId)).ref;
    const store = this.files.stores.byRef(storeRef);
    await store.put(key(parts), Readable.from([Buffer.from(text, 'utf8')]));
    const next = { offset: offset + items.length, parts: parts + 1, storeRef };
    if (items.length === batchSize) return { state: next, progress: next.offset, done: false };

    async function* joined() {
      for (let n = 0; n < next.parts; n++) for await (const chunk of await store.get(key(n))) yield chunk as Buffer;
    }
    const file = await this.files.upload(ctx, { body: joined(), name: this.fileName(type), maxBytes: Number.MAX_SAFE_INTEGER });
    for (let n = 0; n < next.parts; n++) await store.delete(key(n));
    return { state: next, progress: next.offset, done: true, result: { fileId: file.id, rows: next.offset, recordType: type.key } };
  }

  private async columns(ctx: TenantContext, type: RecordTypeDef): Promise<{ label: string; field?: FieldDef; pseudo?: 'number' | 'status' }[]> {
    const workflows = await this.defs.workflowsFor(ctx.tenantId, type.key);
    return [
      ...(type.numbering ? [{ label: 'Number', pseudo: 'number' as const }] : []),
      ...(workflows.length ? [{ label: 'Status', pseudo: 'status' as const }] : []),
      ...type.fields.map((f) => ({ label: f.label, field: f })),
    ];
  }

  private async rows(ctx: TenantContext, type: RecordTypeDef, columns: Awaited<ReturnType<ExportService['columns']>>, items: RecordView[]): Promise<string[]> {
    const lookups = await this.lookups(ctx, type, items);
    return items.map((r) =>
      this.csv.csvLine(
        columns.map((c) => {
          if (c.pseudo === 'number') return r.number ?? '';
          if (c.pseudo === 'status') return r.status ? (lookups.states.get(r.status) ?? r.status) : '';
          if (c.field?.type === 'person' && r.people?.[c.field.key]) return r.people[c.field.key]!.name;
          return this.cell(c.field!, r.data[c.field!.key], lookups);
        }),
      ),
    );
  }

  private async lookups(ctx: TenantContext, type: RecordTypeDef, items: RecordView[]): Promise<Lookups> {
    const states = new Map<string, string>();
    for (const w of await this.defs.workflowsFor(ctx.tenantId, type.key)) for (const s of w.body.states) if (!states.has(s.key)) states.set(s.key, s.label);
    const references = new Map<string, Map<string, string>>();
    for (const f of type.fields) {
      if (f.type !== 'reference' || !f.referenceType || references.has(f.referenceType)) continue;
      const ids = type.fields
        .filter((x) => x.type === 'reference' && x.referenceType === f.referenceType)
        .flatMap((x) => items.map((r) => r.data[x.key]))
        .filter((v): v is string => typeof v === 'string');
      references.set(f.referenceType, await this.records.displayNames(ctx, f.referenceType, ids));
    }
    const fileIds = type.fields
      .filter((f) => f.type === 'file' || f.type === 'signature')
      .flatMap((f) => items.flatMap((r) => (f.type === 'signature' ? [(r.data[f.key] as { file?: unknown } | undefined)?.file] : listOf(r.data[f.key]))))
      .filter((v): v is string => typeof v === 'string' && v !== MASK);
    const files = fileIds.length ? await this.files.namesOf(ctx.tenantId, fileIds) : new Map<string, string>();
    return { states, references, files };
  }

  private cell(f: FieldDef, v: unknown, lookups: Lookups): string {
    if (v === undefined || v === null) return '';
    if (v === MASK) return MASK;
    const label = (x: unknown) => f.choices?.find((c) => c.value === x)?.label ?? String(x);
    switch (f.type) {
      case 'boolean':
        return v ? 'Yes' : 'No';
      case 'choice':
        return label(v);
      case 'multiChoice':
        return listOf(v).map(label).join('; ');
      case 'reference':
        return lookups.references.get(f.referenceType ?? '')?.get(String(v)) ?? String(v);
      case 'file':
        return listOf(v).map((id) => lookups.files.get(String(id)) ?? String(id)).join('; ');
      case 'signature': {
        const s = v as { signedBy?: string; signedAt?: string };
        return [s.signedBy, s.signedAt?.slice(0, 10)].filter(Boolean).join(', ');
      }
      case 'location': {
        const p = v as { lat?: number; lng?: number };
        return `${p.lat}, ${p.lng}`;
      }
      case 'richText':
        return typeof v === 'string' ? richTextToPlain(v) : '';
      default:
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }

  private fileName(type: RecordTypeDef): string {
    return `${(type.pluralLabel ?? type.label).replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || type.key} ${new Date().toISOString().slice(0, 10)}.csv`;
  }

  private async typeOf(ctx: TenantContext, typeKey: string): Promise<RecordTypeDef> {
    const type = await this.defs.get(ctx.tenantId, 'recordType', typeKey);
    if (!type) throw notFound(`Unknown record type '${typeKey}'.`);
    return type.body;
  }
}
