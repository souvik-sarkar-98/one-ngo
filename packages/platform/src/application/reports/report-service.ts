import { Readable } from 'node:stream';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, notFound, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import { ScriptFailure } from '../../domain/script-failure.js';
import { can, demand } from '../../domain/permissions.js';
import type { AuditTrail } from '../../domain/ports/audit-trail.js';
import type { OrganisationName } from '../../domain/ports/organisation-name.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionReader } from '../../runtime/definitions/definition-service.js';
import { renderDocumentHtml, DocumentTemplateError } from '../../runtime/definitions/document-template.js';
import type { FieldFilter, ReportDataset, ReportDef, ReportGroupDef } from '../../runtime/definitions/types.js';
import type { PublishedFormat, PublishedReportRow, PublishedReportStore, PublishedSnapshot } from './published-store.js';
import { compileExpression } from '../../runtime/expressions/expression.js';
import type { RecordAggregates } from '../../runtime/records/aggregates.js';
import type { JobRunner } from '../../runtime/records/ports/job-runner.js';
import type { RecordService } from '../../runtime/records/record-service.js';
import type { ScriptSandbox } from '../../runtime/scripts/sandbox.js';
import type { FileService } from '../files/file-service.js';
import { renderSheetsHtml, renderWorkbook } from './excel.js';
import { MANAGEMENT_REPORT, type ReportDatasetView, type ReportModel, type ReportProviders } from './model.js';

export const REPORT_INLINE_ROWS = 5_000;
export const REPORT_SHAPE_BYTES = 2 * 1024 * 1024;
export const REPORT_SHAPE_TIMEOUT_MS = 3_000;
const PAGE = 1_000;
/** The kept JSON: the rows, and for a PDF the document template. */
const MODEL_MAX = 8_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReportSummary {
  key: string;
  label: string;
  /** The one file the report makes. */
  format: PublishedFormat;
  parameters: ReportDef['parameters'];
  /** The first report group that lists it, or null when it is ungrouped. */
  group: { key: string; label: string; order: number } | null;
}

/** A file kept when the report was published: its parameters, who published it and when. */
export interface PublishedReport {
  id: string;
  reportKey: string;
  title: string;
  format: PublishedFormat;
  params: Record<string, unknown>;
  createdByName: string | null;
  createdAt: string;
}

/** The first group that lists the report. A report in several groups shows in the earliest. */
export function groupOf(reportKey: string, groups: ReportGroupDef[]): ReportSummary['group'] {
  const sorted = [...groups].sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.label.localeCompare(b.label));
  const found = sorted.find((g) => g.reports.includes(reportKey));
  return found ? { key: found.key, label: found.label, order: found.order ?? 1000 } : null;
}

/** A report makes a PDF when it has a PDF output, and an Excel workbook otherwise. */
export const formatOf = (def: ReportDef): PublishedFormat => (def.outputs?.pdf ? 'pdf' : 'excel');

const summaryOf = (key: string, def: ReportDef, groups: ReportGroupDef[]): ReportSummary => ({
  key,
  label: def.label,
  format: formatOf(def),
  parameters: def.parameters ?? [],
  group: groupOf(key, groups),
});

const publishedOf = (row: PublishedReportRow): PublishedReport => ({
  id: row.id,
  reportKey: row.reportKey,
  title: row.title,
  format: row.format,
  params: row.params,
  createdByName: row.createdByName,
  createdAt: row.createdAt,
});

interface ReportInput {
  key: string;
  params: Record<string, unknown>;
}

/** A report is built in the request when it is small and has no shape script. */
export function reportRunsInline(rows: number, shapeScript: boolean, limit = REPORT_INLINE_ROWS): boolean {
  return !shapeScript && rows <= limit;
}

function audienceAllows(ctx: TenantContext, def: ReportDef): boolean {
  if (!def.audience?.length || ctx.actor.permissions.some((p) => p === '*')) return true;
  return def.audience.some((role) => ctx.actor.roles.includes(role));
}

function parametersOf(def: ReportDef, raw: unknown): Record<string, unknown> {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw validationFailed('Parameters must be an object.');
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const issues: FieldIssue[] = [];
  for (const p of def.parameters ?? []) {
    const value = input[p.key];
    const blank = value === undefined || value === null || value === '';
    if (blank) {
      if (p.required) issues.push({ path: `/${p.key}`, message: 'is required' });
      continue;
    }
    if (p.type === 'number' || p.type === 'money') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) issues.push({ path: `/${p.key}`, message: 'must be a number' });
      else out[p.key] = n;
    } else if (p.type === 'boolean') {
      if (typeof value !== 'boolean') issues.push({ path: `/${p.key}`, message: 'must be yes or no' });
      else out[p.key] = value;
    } else if (p.type === 'date') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) issues.push({ path: `/${p.key}`, message: 'must be a date' });
      else out[p.key] = value;
    } else if (p.type === 'choice') {
      if (typeof value !== 'string' || !p.choices?.some((c) => c.value === value)) issues.push({ path: `/${p.key}`, message: 'is not one of the choices' });
      else out[p.key] = value;
    } else if (typeof value !== 'string') issues.push({ path: `/${p.key}`, message: 'must be text' });
    else out[p.key] = value;
  }
  if (issues.length) throw validationFailed('Some parameters are not valid.', issues);
  return out;
}

const PARTIAL = /\{\{\s*>\s*([a-z][a-zA-Z0-9_-]{0,62})\s*\}\}/g;

/** The partials a document names, including partials those partials name. */
function namedPartials(html: string, available: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  const queue = [html];
  while (queue.length) {
    const src = queue.pop()!;
    for (const match of src.matchAll(PARTIAL)) {
      const name = match[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      const body = available.get(name);
      if (body === undefined) continue;
      out[name] = body;
      queue.push(body);
    }
  }
  return out;
}

/** A report definition carrying only the sheet layout, enough to build the workbook again. */
function excelReport(excel: NonNullable<PublishedSnapshot['excel']>): ReportDef {
  return {
    key: 'published',
    label: excel.label,
    datasets: excel.sheets.map((sheet) => ({ key: sheet.dataset, source: 'query', recordType: '_', fields: [] })),
    outputs: { excel: { sheets: excel.sheets } },
  };
}

function titleOf(def: ReportDef, params: Record<string, unknown>, raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 120);
  const from = typeof params.from === 'string' ? params.from : '';
  const to = typeof params.to === 'string' ? params.to : '';
  return (from && to ? `${def.label}, ${from} to ${to}` : def.label).slice(0, 120);
}

function filled(expr: string | undefined, scope: Record<string, unknown>): unknown {
  if (!expr?.trim()) return undefined;
  const value = compileExpression(expr).evaluate(scope);
  return value === null || value === undefined || value === '' ? undefined : value;
}

function filtersOf(dataset: ReportDataset, scope: Record<string, unknown>): Record<string, FieldFilter> | undefined {
  if (dataset.source === 'ledger' || !dataset.filters) return undefined;
  const out: Record<string, FieldFilter> = {};
  for (const [field, filter] of Object.entries(dataset.filters)) {
    const one: FieldFilter = {};
    const eq = filled(filter.eq, scope);
    const from = filled(filter.from, scope);
    const to = filled(filter.to, scope);
    if (typeof eq === 'string' || typeof eq === 'number' || typeof eq === 'boolean') one.eq = eq;
    if (typeof from === 'string' || typeof from === 'number') one.from = from;
    if (typeof to === 'string' || typeof to === 'number') one.to = to;
    if (Object.keys(one).length) out[field] = one;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Builds a report's data model and its Excel workbook. A short report with no
 * shape script answers at once. A longer one, or one with a shape script, is
 * a `report` job: the script runs only there, capped at 2 MB and 3 seconds.
 */
export class ReportService {
  constructor(
    private readonly tm: TransactionManager,
    private readonly defs: DefinitionReader,
    private readonly records: RecordService,
    private readonly aggregates: RecordAggregates,
    private readonly files: FileService,
    private readonly jobs: JobRunner,
    private readonly audit: AuditTrail,
    private readonly sandbox: ScriptSandbox,
    private readonly organisationName: OrganisationName,
    private readonly providers: ReportProviders,
    private readonly published?: PublishedReportStore,
    private readonly inlineRows = REPORT_INLINE_ROWS,
  ) {
    jobs.register<ReportInput, Record<string, unknown>>('report', {
      label: 'Report',
      requires: (input) => `report:${input.key}:run`,
      run: async (job) => {
        const def = await this.definition(job.ctx, job.input.key);
        const model = await this.model(job.ctx, def, job.input.params, true);
        const bytes = await renderWorkbook(def, model);
        const file = await this.files.upload(job.ctx, {
          body: Readable.from([bytes]),
          name: `${def.label}.xlsx`,
        });
        const rows = Object.values(model.datasets).reduce((n, d) => n + d.rows.length, 0);
        return { state: {}, progress: rows, done: true, result: { fileId: file.id, rows } };
      },
      notice: (job) => {
        const result = job.result as { fileId?: string; rows?: number } | null;
        if (job.status !== 'done' || !result?.fileId) return { subject: 'Report failed', body: job.error ? `The report stopped: ${job.error}.` : 'The report stopped.' };
        return { subject: 'Report ready', body: `Your report of ${result.rows ?? 0} rows is ready to download.`, link: `/api/files/${result.fileId}` };
      },
    });
  }

  /** Reports this person may run, with their group and format. */
  async list(ctx: TenantContext): Promise<ReportSummary[]> {
    const [all, groups] = await Promise.all([this.defs.list(ctx.tenantId, 'report'), this.defs.list(ctx.tenantId, 'reportGroup')]);
    const bodies = groups.map((g) => g.body);
    return all.filter((r) => can(ctx.actor, `report:${r.key}:run`) && audienceAllows(ctx, r.body)).map((r) => summaryOf(r.key, r.body, bodies));
  }

  /** One report and the files published from it, newest first. */
  async report(ctx: TenantContext, key: string): Promise<{ report: ReportSummary; published: PublishedReport[] }> {
    const def = await this.definition(ctx, key);
    const groups = (await this.defs.list(ctx.tenantId, 'reportGroup')).map((g) => g.body);
    const rows = this.published ? await this.tm.withTenant(ctx.tenantId, (tx) => this.published!.list(tx, key)) : [];
    return { report: summaryOf(key, def, groups), published: rows.map(publishedOf) };
  }

  /** One published file and its page, rebuilt from the JSON kept for it. */
  async getPublished(ctx: TenantContext, id: string): Promise<PublishedReport & { html: string }> {
    const row = await this.kept(ctx, id);
    return { ...publishedOf(row), html: this.pageFrom(row.model) };
  }

  /** The Excel file, built from the JSON kept for a report published as Excel. */
  async downloadPublished(ctx: TenantContext, id: string): Promise<{ fileName: string; bytes: Buffer }> {
    const row = await this.kept(ctx, id);
    if (row.format !== 'excel' || !row.model.excel) throw notFound('This report file does not exist.');
    const bytes = await renderWorkbook(excelReport(row.model.excel), row.model.model);
    return { fileName: `${row.title}.xlsx`, bytes };
  }

  /** Runs the report and keeps the JSON the page or the workbook is built from. */
  async publish(ctx: TenantContext, key: string, raw: unknown): Promise<{ id: string; title: string; format: PublishedFormat }> {
    if (!this.published) throw validationFailed('Publishing reports is not available.');
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { params?: unknown; title?: unknown }) : {};
    const def = await this.definition(ctx, key);
    const params = parametersOf(def, body.params);
    const format = formatOf(def);
    const model = await this.model(ctx, def, params, false);
    const snapshot = await this.snapshot(ctx, def, model);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MODEL_MAX) throw validationFailed('This report is too large to publish.');
    if (!this.pageFrom(snapshot)) throw validationFailed('This report has no page to publish.');
    const title = titleOf(def, params, body.title);
    const saved = await this.tm.withTenant(ctx.tenantId, async (tx) => {
      await this.audit.audit(tx, { actorId: ctx.actor.id, action: 'reports.publish', entity: `report:${key}`, after: { title, params, format } });
      return this.published!.insert(tx, { reportKey: key, title, params, format, model: snapshot, createdBy: ctx.actor.id });
    });
    return { id: saved.id, title, format };
  }

  /** The data model and the page a person checks before publishing. Nothing is kept. */
  async preview(
    ctx: TenantContext,
    key: string,
    raw: unknown,
  ): Promise<{ model: ReportModel; html: string; format: PublishedFormat; shape: 'none' | 'provider' | 'job' }> {
    const def = await this.definition(ctx, key);
    const params = parametersOf(def, raw);
    const model = await this.model(ctx, def, params, false);
    await this.audited(ctx, key, params, model, 'preview');
    const shape = def.shape && 'script' in def.shape ? 'job' : def.shape && 'provider' in def.shape ? 'provider' : 'none';
    return { model, html: await this.page(ctx, def, model), format: formatOf(def), shape };
  }

  /** The workbook, or the job that writes it when the report is too large or has a shape script. */
  async run(ctx: TenantContext, key: string, raw: unknown): Promise<{ jobId: string } | { fileName: string; bytes: Buffer }> {
    const def = await this.definition(ctx, key);
    const params = parametersOf(def, raw);
    const rows = await this.countRows(ctx, def, params);
    const total = Object.values(rows).reduce((n, v) => n + v, 0);
    await this.tm.withTenant(ctx.tenantId, (tx) =>
      this.audit.audit(tx, { actorId: ctx.actor.id, action: 'reports.run', entity: `report:${key}`, after: { params, rows, format: 'xlsx' } }),
    );
    if (!reportRunsInline(total, !!def.shape && 'script' in def.shape, this.inlineRows)) {
      const job = await this.jobs.create(ctx, 'report', { key, params }, total);
      return { jobId: job.id };
    }
    const model = await this.model(ctx, def, params, false);
    const bytes = await renderWorkbook(def, model);
    return { fileName: `${def.label}.xlsx`, bytes };
  }

  /** One kept file, for someone who may run the report it came from. */
  private async kept(ctx: TenantContext, id: string): Promise<PublishedReportRow & { model: PublishedSnapshot }> {
    if (!this.published || !UUID.test(id)) throw notFound('This report file does not exist.');
    const row = await this.tm.withTenant(ctx.tenantId, (tx) => this.published!.get(tx, id));
    if (!row || !(await this.mayRun(ctx, row.reportKey))) throw notFound('This report file does not exist.');
    return row;
  }

  /** Whether this person may run the report a published file came from, so may open the file. */
  private async mayRun(ctx: TenantContext, key: string): Promise<boolean> {
    const found = await this.defs.get(ctx.tenantId, 'report', key);
    return !!found && can(ctx.actor, `report:${key}:run`) && audienceAllows(ctx, found.body);
  }

  /** The PDF's page, or the Excel workbook's sheets drawn as a page. */
  private async page(ctx: TenantContext, def: ReportDef, model: ReportModel): Promise<string> {
    return formatOf(def) === 'pdf' ? this.html(ctx, def, model) : renderSheetsHtml(def, model);
  }

  /** The layout and data kept for a published file, so it can be printed or built again. */
  private async snapshot(ctx: TenantContext, def: ReportDef, model: ReportModel): Promise<PublishedSnapshot> {
    const pdf = def.outputs?.pdf;
    if (pdf) {
      const template = await this.defs.get(ctx.tenantId, 'template', pdf.template);
      if (!template || (template.body.kind ?? 'message') !== 'document' || !template.body.html) {
        throw validationFailed(`'${pdf.template}' is not a document template.`);
      }
      const all = await this.defs.list(ctx.tenantId, 'template');
      const available = new Map(all.filter((t) => t.body.html).map((t) => [t.key, t.body.html!] as const));
      return {
        model,
        document: {
          html: template.body.html,
          partials: namedPartials(template.body.html, available),
          pageSize: pdf.pageSize ?? 'A4',
          orientation: pdf.orientation ?? 'portrait',
        },
      };
    }
    const configured = def.outputs?.excel?.sheets ?? [];
    return {
      model,
      excel: {
        label: def.label,
        sheets: configured.length ? configured : def.datasets.map((dataset) => ({ dataset: dataset.key })),
      },
    };
  }

  /** The page, printed from the document kept with the file, or the sheets drawn from the kept rows. */
  private pageFrom(snapshot: PublishedSnapshot): string {
    const document = snapshot.document;
    if (document) {
      let body: string;
      try {
        body = renderDocumentHtml(document.html, snapshot.model as unknown as Record<string, unknown>, (name) => document.partials[name]);
      } catch (e) {
        if (e instanceof DocumentTemplateError) throw validationFailed(e.message);
        throw e;
      }
      return `<style>@page { size: ${document.pageSize} ${document.orientation}; }</style>${body}`;
    }
    return snapshot.excel ? renderSheetsHtml(excelReport(snapshot.excel), snapshot.model) : '';
  }

  private async definition(ctx: TenantContext, key: string): Promise<ReportDef> {
    const found = await this.defs.get(ctx.tenantId, 'report', key);
    if (!found) throw notFound(`Unknown report '${key}'.`);
    demand(ctx.actor, `report:${found.key}:run`);
    if (!audienceAllows(ctx, found.body)) throw forbidden('You cannot run this report.');
    return found.body;
  }

  private async countRows(ctx: TenantContext, def: ReportDef, params: Record<string, unknown>): Promise<Record<string, number>> {
    const scope: Record<string, unknown> = { params };
    const rows: Record<string, number> = {};
    for (const dataset of def.datasets) {
      if (dataset.source !== 'query') {
        rows[dataset.key] = dataset.source === 'ledger' ? (dataset.accounts?.length ?? 0) + (dataset.funds?.length ?? 0) : 1;
        continue;
      }
      const { total } = await this.records.query(ctx, dataset.recordType, {
        filters: filtersOf(dataset, scope),
        statusIn: dataset.statusIn,
        limit: 1,
        withTotal: true,
      });
      rows[dataset.key] = Math.min(total, dataset.limit ?? Number.POSITIVE_INFINITY);
    }
    return rows;
  }

  private async audited(ctx: TenantContext, key: string, params: Record<string, unknown>, model: ReportModel, format: string): Promise<void> {
    const rows = Object.fromEntries(Object.entries(model.datasets).map(([k, d]) => [k, d.total]));
    await this.tm.withTenant(ctx.tenantId, (tx) =>
      this.audit.audit(tx, { actorId: ctx.actor.id, action: 'reports.run', entity: `report:${key}`, after: { params, rows, format } }),
    );
  }

  private async model(ctx: TenantContext, def: ReportDef, params: Record<string, unknown>, shape: boolean): Promise<ReportModel> {
    const scope: Record<string, unknown> = { params };
    const datasets: Record<string, ReportDatasetView> = {};
    for (const dataset of def.datasets) datasets[dataset.key] = await this.dataset(ctx, dataset, scope, shape);
    scope.datasets = datasets;
    const calculations: Record<string, unknown> = {};
    for (const calc of def.calculations ?? []) {
      calculations[calc.key] = compileExpression(calc.expression).evaluate({ params, datasets, calculations });
    }
    const model: ReportModel = {
      org: { name: (await this.organisationName(ctx.tenantId)) ?? '' },
      params,
      datasets,
      calculations,
      generatedAt: new Date().toISOString(),
      label: MANAGEMENT_REPORT,
      title: def.label,
    };
    if (def.shape && 'script' in def.shape && def.shape.script) {
      if (!shape) return model;
      return this.applyScript(ctx, def, model);
    }
    if (def.shape && 'provider' in def.shape && def.shape.provider) return this.applyProvider(def, model);
    return model;
  }

  private async applyProvider(def: ReportDef, model: ReportModel): Promise<ReportModel> {
    const key = def.shape && 'provider' in def.shape ? def.shape.provider : '';
    const provider = this.providers.get(key);
    if (!provider) throw validationFailed(`Report provider '${key}' is not registered.`);
    return provider.shape(model);
  }

  private async applyScript(ctx: TenantContext, def: ReportDef, model: ReportModel): Promise<ReportModel> {
    const key = def.shape && 'script' in def.shape ? def.shape.script : '';
    const script = await this.defs.get(ctx.tenantId, 'script', key);
    if (!script || script.body.hook !== 'reportShape') throw validationFailed(`'${key}' is not a report shape script.`);
    const out = await this.sandbox.run({
      code: script.body.code,
      record: {},
      previous: null,
      status: null,
      recordType: script.body.recordType,
      user: { id: ctx.actor.id, roles: [...ctx.actor.roles] },
      tenantId: ctx.tenantId,
      hook: 'reportShape',
      timeoutMs: REPORT_SHAPE_TIMEOUT_MS,
      memoryMb: script.body.memoryMb ?? 16,
      maxOutputBytes: REPORT_SHAPE_BYTES,
      extra: { params: model.params, datasets: model.datasets, calculations: model.calculations },
    });
    if (out.output.effects.length) throw new ScriptFailure('script_failed', 'A report shape cannot propose effects.', out.logs, out.durationMs);
    const next = out.output.record ?? {};
    const datasets = next['datasets'];
    const calculations = next['calculations'];
    return {
      ...model,
      datasets: datasets && typeof datasets === 'object' && !Array.isArray(datasets) ? (datasets as ReportModel['datasets']) : model.datasets,
      calculations: calculations && typeof calculations === 'object' && !Array.isArray(calculations) ? (calculations as ReportModel['calculations']) : model.calculations,
    };
  }

  private async dataset(ctx: TenantContext, dataset: ReportDataset, scope: Record<string, unknown>, full: boolean): Promise<ReportDatasetView> {
    if (dataset.source === 'ledger') return this.ledger(ctx, dataset, scope);
    if (dataset.source === 'aggregate') return this.aggregate(ctx, dataset, scope);
    return this.query(ctx, dataset, scope, full);
  }

  private async query(ctx: TenantContext, dataset: Extract<ReportDataset, { source: 'query' }>, scope: Record<string, unknown>, full: boolean): Promise<ReportDatasetView> {
    const ceiling = full ? 20_000 : this.inlineRows;
    const limit = Math.min(dataset.limit ?? ceiling, ceiling);
    const filters = filtersOf(dataset, scope);
    const base = { filters, statusIn: dataset.statusIn, sort: dataset.sort, withTotal: false as const };
    const { total } = await this.records.query(ctx, dataset.recordType, { ...base, limit: 1, withTotal: true });
    const rows: Record<string, unknown>[] = [];
    let typeFields: { key: string; type: string; referenceType?: string }[] = [];
    for (let offset = 0; rows.length < Math.min(total, limit); ) {
      const page = await this.records.exportPage(ctx, dataset.recordType, base, offset, Math.min(PAGE, limit - rows.length));
      typeFields = page.type.fields;
      for (const item of page.items) {
        const row: Record<string, unknown> = { id: item.id, number: item.number, status: item.status };
        const wanted = new Set([...(dataset.fields ?? []), ...(dataset.related ?? []).map((r) => r.field)]);
        for (const field of wanted) row[field] = item.data[field] ?? null;
        rows.push(row);
      }
      if (page.items.length < PAGE) break;
      offset += page.items.length;
    }
    for (const related of dataset.related ?? []) {
      const field = typeFields.find((f) => f.key === related.field);
      if (field?.type !== 'reference' || !field.referenceType) continue;
      const ids = [...new Set(rows.map((r) => r[related.field]).filter((id): id is string => typeof id === 'string' && id !== '***'))];
      const found = new Map<string, Record<string, unknown>>();
      for (let i = 0; i < ids.length; i += 200) {
        const page = await this.records.query(ctx, field.referenceType, { ids: ids.slice(i, i + 200), limit: 200, withTotal: false });
        for (const item of page.items) found.set(item.id, Object.fromEntries(related.fields.map((k) => [k, item.data[k] ?? null])));
      }
      for (const row of rows) {
        const id = row[related.field];
        const link = typeof id === 'string' ? (found.get(id) ?? null) : null;
        row['related'] = { ...((row['related'] as Record<string, unknown> | undefined) ?? {}), [related.field]: link };
      }
    }
    return { label: dataset.label || dataset.key, rows, total };
  }

  private async aggregate(ctx: TenantContext, dataset: Extract<ReportDataset, { source: 'aggregate' }>, scope: Record<string, unknown>): Promise<ReportDatasetView> {
    const result = await this.aggregates.aggregate(ctx, dataset.recordType, {
      measure: dataset.measure,
      field: dataset.field,
      groupBy: dataset.groupBy,
      filters: filtersOf(dataset, scope),
      statusIn: dataset.statusIn,
    });
    if ('value' in result) return { label: dataset.label || dataset.key, rows: [{ value: result.value }], total: 1, value: result.value };
    return { label: dataset.label || dataset.key, rows: result.buckets.map((b) => ({ key: b.key, label: b.label, value: b.value })), total: result.buckets.length };
  }

  private async ledger(ctx: TenantContext, dataset: Extract<ReportDataset, { source: 'ledger' }>, scope: Record<string, unknown>): Promise<ReportDatasetView> {
    const asOf = filled(dataset.asOf, scope);
    const date = typeof asOf === 'string' && /^\d{4}-\d{2}-\d{2}/.test(asOf) ? asOf.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const balances = await this.records.ledgerBalances(ctx, dataset.accounts ?? [], dataset.funds ?? [], date);
    const rows = [
      ...Object.entries(balances.accounts).map(([code, balance]) => ({ kind: 'account', code, balance })),
      ...Object.entries(balances.funds).map(([code, balance]) => ({ kind: 'fund', code, balance })),
    ];
    return { label: dataset.label || dataset.key, rows, total: rows.length };
  }

  private async html(ctx: TenantContext, def: ReportDef, model: ReportModel): Promise<string> {
    const pdf = def.outputs?.pdf;
    if (!pdf) return '';
    const template = await this.defs.get(ctx.tenantId, 'template', pdf.template);
    if (!template || (template.body.kind ?? 'message') !== 'document' || !template.body.html) {
      throw validationFailed(`'${pdf.template}' is not a document template.`);
    }
    const all = await this.defs.list(ctx.tenantId, 'template');
    const partials = new Map(all.filter((t) => t.body.html).map((t) => [t.key, t.body.html!] as const));
    const size = pdf.pageSize ?? 'A4';
    const orientation = pdf.orientation ?? 'portrait';
    let body: string;
    try {
      body = renderDocumentHtml(template.body.html, model as unknown as Record<string, unknown>, (name) => partials.get(name));
    } catch (e) {
      if (e instanceof DocumentTemplateError) throw validationFailed(e.message);
      throw e;
    }
    return `<style>@page { size: ${size} ${orientation}; }</style>${body}`;
  }
}

export type { ReportModel, ReportProvider, ReportProviders } from './model.js';
