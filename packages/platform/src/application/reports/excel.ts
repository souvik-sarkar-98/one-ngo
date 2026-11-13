import type { ReportModel } from './model.js';
import type { ReportColumn, ReportDef } from '../../runtime/definitions/types.js';
import { MANAGEMENT_REPORT } from './model.js';

const FORMAT: Record<NonNullable<ReportColumn['format']>, string> = {
  text: '@',
  number: '#,##0.00',
  money: '#,##0.00',
  date: 'yyyy-mm-dd',
  percent: '0.00%',
};

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function sheetName(name: string): string {
  const clean = name.replace(/[\\/*?:[\]]/g, ' ').trim() || 'Sheet';
  return clean.slice(0, 31);
}

function cell(value: unknown, format: ReportColumn['format']): string | number | Date | null {
  if (value === undefined || value === null) return null;
  if (value === '***' || format === 'text' || format === undefined) return typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (format === 'date') {
    const s = String(value);
    const d = /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : new Date(s);
    return Number.isNaN(d.getTime()) ? s : d;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : String(value);
}

interface Sheet {
  name: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}

/** The sheets after the cover: one per configured dataset, or one per dataset when none are configured. */
function sheetsOf(def: ReportDef, model: ReportModel): Sheet[] {
  const specs: { dataset: string; columns?: ReportColumn[] }[] = def.outputs?.excel?.sheets ?? def.datasets.map((d) => ({ dataset: d.key }));
  return specs.map((spec) => {
    const data = model.datasets[spec.dataset];
    const rows = data?.rows ?? [];
    const columns: ReportColumn[] = spec.columns?.length
      ? spec.columns
      : Object.keys(rows[0] ?? {})
          .filter((field) => field !== 'related')
          .map((field) => ({ field }));
    return { name: sheetName(data?.label || spec.dataset), columns, rows };
  });
}

const PREVIEW_ROWS = 200;

const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const shown = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

/** The workbook's sheets as a page, so a person can check an Excel report before it is published. */
export function renderSheetsHtml(def: ReportDef, model: ReportModel): string {
  const params = Object.values(model.params).map(shown).filter(Boolean).join(' · ');
  const sheets = sheetsOf(def, model).map((sheet) => {
    const head = sheet.columns.map((c) => `<th>${escape(c.header || c.field)}</th>`).join('');
    const body = sheet.rows
      .slice(0, PREVIEW_ROWS)
      .map((row) => `<tr>${sheet.columns.map((c) => `<td>${escape(shown(row[c.field]))}</td>`).join('')}</tr>`)
      .join('');
    const more = sheet.rows.length > PREVIEW_ROWS ? `<p class="more">${sheet.rows.length - PREVIEW_ROWS} more rows in the file.</p>` : '';
    return `<section><div class="tab">${escape(sheet.name)}</div><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}</section>`;
  });
  return `<style>
body { font: 13px 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a; margin: 16px; }
h1 { font-size: 16px; margin: 0; } .sub { color: #475569; margin: 2px 0 14px; }
.tab { display: inline-block; border: 1px solid #d5dbe2; border-bottom: 0; border-radius: 6px 6px 0 0; padding: 4px 10px; font-weight: 700; }
table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
th, td { border: 1px solid #e2e8f0; padding: 4px 8px; text-align: left; white-space: nowrap; }
th { background: #f1f5f9; } .more { color: #475569; }
</style><h1>${escape(def.label)}</h1><p class="sub">${escape(params)}</p>${sheets.join('')}`;
}

/** An xlsx workbook: a cover sheet, then one sheet per configured dataset. */
export async function renderWorkbook(def: ReportDef, model: ReportModel): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const { PassThrough } = await import('node:stream');
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  const cover = workbook.addWorksheet('Cover');
  cover.addRow([MANAGEMENT_REPORT]).commit();
  cover.addRow([def.label]).commit();
  cover.addRow(['Organisation', model.org.name]).commit();
  cover.addRow(['Generated', model.generatedAt]).commit();
  cover.addRow([]).commit();
  cover.addRow(['Parameter', 'Value']).commit();
  for (const [key, value] of Object.entries(model.params)) cover.addRow([key, value === null || value === undefined ? '' : String(value)]).commit();
  for (const [key, value] of Object.entries(model.calculations)) cover.addRow([key, value === null || value === undefined ? '' : String(value)]).commit();
  cover.commit();

  for (const { name, columns, rows } of sheetsOf(def, model)) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    if (columns.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(rows.length + 1, 1), column: columns.length } };
    sheet.addRow(columns.map((c) => c.header || c.field)).commit();
    for (const row of rows) {
      const line = sheet.addRow(columns.map((c) => cell(row[c.field], c.format)));
      columns.forEach((c, i) => {
        if (c.format && c.format !== 'text') line.getCell(i + 1).numFmt = FORMAT[c.format];
      });
      line.commit();
    }
    if (columns.some((c) => c.total) && rows.length) {
      const last = rows.length + 1;
      const total = sheet.addRow(
        columns.map((c, i) => (c.total ? { formula: `SUM(${columnName(i)}2:${columnName(i)}${last})` } : i === 0 ? 'Total' : null)),
      );
      total.commit();
    }
    sheet.commit();
  }
  await workbook.commit();
  return done;
}
