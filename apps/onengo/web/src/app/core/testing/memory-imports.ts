import type { FileDownload } from '../http/http';
import type { FieldDef, RecordView, RuntimeRecordType } from '../models';
import type { CheckResult, ExportOutcome, ImportExportGateway, ImportMapping, ImportProblem, ImportView, JobView } from '../records/import/import-session';
import { importableFields } from '../records/import/import-session';
import type { MemoryGateways } from './memory-gateway';

export interface MemoryImportExport extends ImportExportGateway {
  /** Every call made, in order. */
  calls: { op: string; args: unknown[] }[];
}

interface StoredImport {
  view: ImportView;
  rows: { row: number; cells: string[] }[];
}

interface StoredJob {
  job: JobView;
  importId: string;
  next: number;
  failed: { cells: string[]; reason: string }[];
}

const fail = (code: string, message: string) => ({ code, message, issues: [] });
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const blank = (v: unknown) => v === undefined || v === null || v === '';
const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvLine = (cells: string[]) => cells.map(csvCell).join(',');

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) rows.push([...row, cell]);
  return rows;
}

/**
 * The import and export ports over a memory gateway's records, keeping the
 * server's observable steps: upload with suggested matches, mapping, a check
 * that saves nothing, a job that saves `batchSize` rows each time its progress
 * is read, cancelling, failed rows, and exports that run as a job above
 * `inlineRows`.
 */
export function memoryImportExport(mg: MemoryGateways, options: { batchSize?: number; inlineRows?: number } = {}): MemoryImportExport {
  const batchSize = options.batchSize ?? 2;
  const inlineRows = options.inlineRows ?? 1000;
  const calls: MemoryImportExport['calls'] = [];
  const imports = new Map<string, StoredImport>();
  const jobs = new Map<string, StoredJob>();
  let ids = 0;
  const log = (op: string, args: unknown[]) => calls.push({ op, args: structuredClone(args) });
  const typeOf = async (key: string): Promise<RuntimeRecordType> => {
    const t = (await mg.auth.definitions()).recordTypes.find((x) => x.key === key);
    if (!t) throw fail('not_found', `Unknown record type '${key}'.`);
    return t;
  };
  const stored = (id: string) => {
    const s = imports.get(id);
    if (!s) throw fail('not_found', 'Import not found.');
    return s;
  };
  const copy = (s: StoredImport): ImportView => structuredClone(s.view);

  /** A row as record data and its problems, and the record it updates when one matches. */
  const prepare = async (type: RuntimeRecordType, s: StoredImport, cells: string[], row: number) => {
    const mapping = s.view.mapping!;
    const data: Record<string, unknown> = {};
    const problems: ImportProblem[] = [];
    s.view.columns.forEach((col, i) => {
      const f = type.fields.find((x) => x.key === mapping.columns[col.name]);
      const raw = (cells[i] ?? '').trim();
      if (!f || raw === '') return;
      if (f.type === 'number' || f.type === 'money') {
        const n = Number(raw.replace(/,/g, ''));
        if (Number.isFinite(n)) data[f.key] = n;
        else problems.push({ row, column: col.name, field: f.key, message: `${f.label} is not a number` });
      } else data[f.key] = raw;
    });
    for (const f of type.fields as FieldDef[]) {
      if (f.required && !f.calculated && f.type !== 'boolean' && blank(data[f.key])) problems.push({ row, field: f.key, message: `${f.label} is required.` });
    }
    let existing: RecordView | null = null;
    const by = mapping.updateBy;
    if (by && !problems.length && !blank(data[by])) {
      existing = (await mg.records.query(type.key, { filters: { [by]: { in: [String(data[by])] } }, limit: 1 })).items[0] ?? null;
    }
    return { data, problems, existing };
  };

  const csvOf = (type: RuntimeRecordType, records: RecordView[]): FileDownload => {
    const fields = type.fields.filter((f) => !f.sensitive);
    const lines = [csvLine(['Number', ...fields.map((f) => f.label)]), ...records.map((r) => csvLine([r.number ?? '', ...fields.map((f) => String(r.data[f.key] ?? ''))]))];
    return { fileName: `${type.pluralLabel ?? type.label}.csv`, body: new Blob([`\uFEFF${lines.join('\r\n')}\r\n`], { type: 'text/csv' }) };
  };
  const exported = (type: RuntimeRecordType, records: RecordView[]): ExportOutcome => {
    if (records.length > inlineRows) return { kind: 'job', jobId: `export-job-${++ids}` };
    return { kind: 'file', file: csvOf(type, records) };
  };

  return {
    calls,
    async upload(type, file, fileName) {
      log('upload', [type, fileName]);
      const t = await typeOf(type);
      if (!/\.csv$/i.test(fileName)) throw fail('validation_failed', 'Choose a CSV file (.csv).');
      const all = parseCsv(await file.text());
      const header = all[0] ?? [];
      const rows = all
        .slice(1)
        .map((cells, i) => ({ row: i + 2, cells }))
        .filter((r) => r.cells.some((c) => c.trim() !== ''));
      if (!header.length) throw fail('validation_failed', 'The file has no heading row.');
      if (!rows.length) throw fail('validation_failed', 'The file has no rows to import.');
      const used = new Set<string>();
      const suggested: Record<string, string | null> = {};
      for (const name of header) {
        const f = importableFields(t).find((x) => !used.has(x.key) && squash(name) !== '' && (squash(x.label) === squash(name) || squash(x.key) === squash(name)));
        suggested[name] = f?.key ?? null;
        if (f) used.add(f.key);
      }
      const id = `import-${++ids}`;
      const view: ImportView = {
        id,
        type,
        fileName,
        columns: header.map((name, i) => ({ name, samples: rows.map((r) => (r.cells[i] ?? '').trim()).filter(Boolean).slice(0, 3) })),
        rowCount: rows.length,
        mapping: null,
        suggested,
        options: {},
        status: 'uploaded',
        check: null,
        jobId: null,
        counts: null,
      };
      imports.set(id, { view, rows });
      return structuredClone(view);
    },
    async get(id) {
      log('get', [id]);
      const s = stored(id);
      const job = s.view.jobId ? jobs.get(s.view.jobId) : undefined;
      if (s.view.status === 'running' && job && (job.job.status === 'failed' || job.job.status === 'cancelled')) s.view.status = 'failed';
      return copy(s);
    },
    async setMapping(id, mapping: ImportMapping) {
      log('setMapping', [id, mapping]);
      const s = stored(id);
      if (!['uploaded', 'mapped', 'checked'].includes(s.view.status)) throw fail('conflict', 'This import has already started.');
      const t = await typeOf(s.view.type);
      const columns = { ...s.view.suggested, ...mapping.columns };
      const mapped = Object.values(columns).filter((v): v is string => !!v);
      if (mapped.some((k, i) => mapped.indexOf(k) !== i)) throw fail('validation_failed', 'More than one column fills the same field.');
      if (!mapped.length) throw fail('validation_failed', 'Match at least one column to a field.');
      if (mapping.updateBy && !(t.fields.find((f) => f.key === mapping.updateBy) as { unique?: boolean } | undefined)?.unique) {
        throw fail('validation_failed', 'Records can be updated only by a unique field.');
      }
      s.view = { ...s.view, mapping: { columns, ...(mapping.updateBy ? { updateBy: mapping.updateBy } : {}) }, options: mapping.quiet ? { quiet: true } : {}, status: 'mapped', check: null };
      return copy(s);
    },
    async check(id) {
      log('check', [id]);
      const s = stored(id);
      if (s.view.status !== 'mapped' && s.view.status !== 'checked') throw fail('conflict', 'Match the columns first.');
      const t = await typeOf(s.view.type);
      const result: CheckResult = { rows: s.rows.length, valid: 0, invalid: 0, creates: 0, updates: 0, problems: [] };
      for (const r of s.rows) {
        const { problems, existing } = await prepare(t, s, r.cells, r.row);
        if (problems.length) {
          result.invalid++;
          result.problems.push(...problems.slice(0, 200 - result.problems.length));
        } else {
          result.valid++;
          if (existing) result.updates++;
          else result.creates++;
        }
      }
      s.view = { ...s.view, status: 'checked', check: result };
      return structuredClone(result);
    },
    async run(id) {
      log('run', [id]);
      const s = stored(id);
      if (s.view.status !== 'mapped' && s.view.status !== 'checked') throw fail('conflict', 'This import has already started.');
      const jobId = `job-${++ids}`;
      jobs.set(jobId, {
        job: { id: jobId, kind: 'import', status: 'queued', progress: 0, total: s.rows.length, error: null, cancelRequested: false, startedAt: null },
        importId: id,
        next: 0,
        failed: [],
      });
      s.view = { ...s.view, status: 'running', jobId, counts: { created: 0, updated: 0, failed: 0 } };
      return copy(s);
    },
    async job(id) {
      log('job', [id]);
      const j = jobs.get(id);
      if (!j) throw fail('not_found', 'Job not found.');
      if (j.job.status === 'queued' || j.job.status === 'running') {
        const s = stored(j.importId);
        const t = await typeOf(s.view.type);
        const counts = s.view.counts!;
        j.job.status = 'running';
        j.job.startedAt ??= '2026-10-24T10:40:00.000Z';
        for (const r of s.rows.slice(j.next, j.next + batchSize)) {
          const { data, problems, existing } = await prepare(t, s, r.cells, r.row);
          try {
            if (problems.length) throw fail('invalid', problems.map((p) => p.message).join('; '));
            if (existing) await mg.records.update(t.key, existing.id, data, existing.version);
            else await mg.records.create(t.key, data);
            counts[existing ? 'updated' : 'created']++;
          } catch (e) {
            counts.failed++;
            j.failed.push({ cells: r.cells, reason: (e as { message?: string }).message ?? '' });
          }
        }
        j.next = Math.min(s.rows.length, j.next + batchSize);
        j.job.progress = j.next;
        if (j.next >= s.rows.length) {
          j.job.status = 'done';
          s.view.status = 'done';
        }
      }
      return structuredClone(j.job);
    },
    async cancelJob(id) {
      log('cancelJob', [id]);
      const j = jobs.get(id);
      if (!j) throw fail('not_found', 'Job not found.');
      if (j.job.status === 'queued' || j.job.status === 'running') Object.assign(j.job, { status: 'cancelled', cancelRequested: true });
      return structuredClone(j.job);
    },
    async failedRows(id) {
      log('failedRows', [id]);
      const s = stored(id);
      const j = s.view.jobId ? jobs.get(s.view.jobId) : undefined;
      if (!j) throw fail('conflict', 'This import has not run yet.');
      const lines = [csvLine([...s.view.columns.map((c) => c.name), 'Reason']), ...j.failed.map((f) => csvLine([...s.view.columns.map((_, i) => f.cells[i] ?? ''), f.reason]))];
      return { fileName: `Failed rows - ${s.view.fileName}`, body: new Blob([`\uFEFF${lines.join('\r\n')}\r\n`], { type: 'text/csv' }) };
    },
    async exportList(type, query) {
      log('exportList', [type, query]);
      const t = await typeOf(type);
      const all: RecordView[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await mg.records.query(type, { ...query, limit: 100, offset });
        all.push(...page.items);
        if (all.length >= page.total || !page.items.length) break;
      }
      return exported(t, all);
    },
    async exportSelected(type, ids) {
      log('exportSelected', [type, ids]);
      const t = await typeOf(type);
      return exported(t, await Promise.all(ids.map((id) => mg.records.get(type, id))));
    },
  };
}
