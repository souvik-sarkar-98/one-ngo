import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { ReportService, formatOf, groupOf, reportRunsInline } from '../src/application/reports/report-service.js';
import { renderSheetsHtml, renderWorkbook } from '../src/application/reports/excel.js';
import { ReportProviders, type ReportModel } from '../src/application/reports/model.js';
import type { TenantContext } from '../src/domain/ports/tenant-context.js';
import { renderDocumentHtml, checkDocumentTemplate } from '../src/runtime/definitions/document-template.js';
import { sanitiseDocumentHtml } from '../src/shared/records/email-html.js';
import type { ReportDef } from '../src/runtime/definitions/types.js';
import type { JobRunner } from '../src/runtime/records/ports/job-runner.js';

const sample = (): ReportDef => ({
  key: 'sample',
  label: 'Sample',
  datasets: [{ key: 'rows', label: 'Rows', source: 'query', recordType: 'donation', fields: ['amount'] }],
  outputs: { excel: { sheets: [{ dataset: 'rows', columns: [{ field: 'amount', header: 'Amount', format: 'money', total: true }] }] } },
});

const model = (amount: unknown): ReportModel => ({
  org: { name: 'Riverbank' },
  params: { from: '2026-04-01' },
  datasets: { rows: { label: 'Rows', rows: [{ amount }], total: 1 } },
  calculations: { total: 10 },
  generatedAt: '2026-11-05T00:00:00.000Z',
  label: 'Management report',
  title: 'Sample',
});

describe('document templates', () => {
  it('fills each and if, includes a partial, and escapes values', () => {
    const html = renderDocumentHtml(
      '<h1>{{ title }}</h1>{{> letterhead}}{{#each rows as row}}<p>{{ row.name }}</p>{{/each}}{{#if show}}<p>Shown</p>{{else}}<p>Hidden</p>{{/if}}',
      { title: 'A & B', rows: [{ name: '<b>Ada</b>' }], show: true },
      (name) => (name === 'letterhead' ? '<p>Letterhead</p>' : undefined),
    );
    expect(html).toContain('A &amp; B');
    expect(html).toContain('Letterhead');
    expect(html).toContain('&lt;b&gt;Ada&lt;/b&gt;');
    expect(html).toContain('Shown');
    expect(html).not.toContain('Hidden');
    expect(checkDocumentTemplate('{{#each rows as row}}{{/each}}')).toEqual([]);
    expect(checkDocumentTemplate('{{#if}}{{/if}}').join(' ')).toMatch(/expression/);
  });

  it('drops scripts and remote images, and keeps a local image and page style', () => {
    const html = sanitiseDocumentHtml(
      '<style>@page { size: A4; margin: 14mm; } p { color: red; }</style><script>alert(1)</script><img src="https://example.com/a.png"><img src="/api/files/logo.png"><p>Hi</p>',
    );
    expect(html).not.toContain('script');
    expect(html).not.toContain('example.com');
    expect(html).toContain('src="/api/files/logo.png"');
    expect(html).toContain('@page { size: A4; margin: 14mm; }');
    expect(html).not.toContain('color');
    expect(html).toContain('<p>Hi</p>');
  });
});

describe('report workbooks', () => {
  it('writes a cover, a money total and a masked value as text', async () => {
    const bytes = await renderWorkbook(sample(), model('***'));
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as never);
    const cover = book.getWorksheet('Cover')!;
    expect(cover.getCell('A1').value).toBe('Management report');
    expect(cover.getCell('B3').value).toBe('Riverbank');
    const sheet = book.getWorksheet('Rows')!;
    expect(sheet.getCell('A1').value).toBe('Amount');
    expect(sheet.getCell('A2').value).toBe('***');
    expect(sheet.getCell('A3').value).toMatchObject({ formula: 'SUM(A2:A2)' });
  });
});

describe('report groups and formats', () => {
  it('puts a report in the earliest group', () => {
    expect(groupOf('donationSummary', [
      { key: 'later', label: 'Later', order: 20, reports: ['donationSummary'] },
      { key: 'fundraising', label: 'Fundraising', order: 10, reports: ['donationSummary'] },
    ])).toEqual({ key: 'fundraising', label: 'Fundraising', order: 10 });
    expect(groupOf('cashbook', [])).toBeNull();
  });

  it('makes one file: a PDF when the report has a PDF output, otherwise Excel', () => {
    expect(formatOf(sample())).toBe('excel');
    expect(formatOf({ ...sample(), outputs: { pdf: { template: 'statement' } } })).toBe('pdf');
    expect(formatOf({ ...sample(), outputs: undefined })).toBe('excel');
  });

  it('draws the Excel sheets as a page, escaping values', () => {
    const html = renderSheetsHtml(sample(), model('<b>10</b>'));
    expect(html).toContain('<div class="tab">Rows</div>');
    expect(html).toContain('<th>Amount</th>');
    expect(html).toContain('&lt;b&gt;10&lt;/b&gt;');
    expect(html).not.toContain('<b>10</b>');
  });
});

describe('report jobs', () => {
  const ctx = { tenantId: 't1', actor: { id: 'u1', roles: [], permissions: ['report:sample:run'] } } as TenantContext;

  function service(total: number, shape?: ReportDef['shape']) {
    const created: string[] = [];
    const jobs = {
      register: () => undefined,
      create: async () => {
        created.push('report');
        return { id: 'job-1' };
      },
    } as unknown as JobRunner;
    const def = { ...sample(), ...(shape ? { shape } : {}) };
    const reports = new ReportService(
      { withTenant: async (_id: string, run: (tx: never) => Promise<unknown>) => run({} as never) } as never,
      { get: async () => ({ key: 'sample', body: def }), list: async () => [] } as never,
      {
        query: async () => ({ items: [], total }),
        exportPage: async () => ({ type: { fields: [] }, items: [{ id: 'r1', number: '1', status: 'paid', data: { amount: 10 } }] }),
      } as never,
      {} as never,
      {} as never,
      jobs,
      { audit: async () => undefined } as never,
      {} as never,
      async () => 'Riverbank',
      new ReportProviders(),
    );
    return { reports, created };
  }

  it('answers a short report at once and queues a long one or a shape script', async () => {
    expect(reportRunsInline(5000, false)).toBe(true);
    expect(reportRunsInline(5001, false)).toBe(false);
    expect(reportRunsInline(1, true)).toBe(false);
    const small = service(1);
    const ready = await small.reports.run(ctx, 'sample', {});
    expect(small.created).toEqual([]);
    expect('bytes' in ready).toBe(true);
    const large = service(5001);
    await expect(large.reports.run(ctx, 'sample', {})).resolves.toEqual({ jobId: 'job-1' });
    expect(large.created).toEqual(['report']);
    const shaped = service(1, { script: 'shapeIt' });
    await expect(shaped.reports.run(ctx, 'sample', {})).resolves.toEqual({ jobId: 'job-1' });
  });
});
