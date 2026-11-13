import { describe, expect, it } from 'vitest';
import { reportSections, type RunnableReport } from './report-groups';

const reports: RunnableReport[] = [
  { key: 'donationSummary', label: 'Donation summary', group: { key: 'fundraising', label: 'Fundraising', order: 10 } },
  { key: 'cashbook', label: 'Cash book', group: null },
  { key: 'receipts', label: 'Receipts', group: { key: 'fundraising', label: 'Fundraising', order: 10 } },
];

describe('report sections', () => {
  it('groups reports and leaves the rest under Other', () => {
    const sections = reportSections(reports, new Set(), 'Other');
    expect(sections.map((s) => [s.key, s.reports.map((r) => r.key)])).toEqual([
      ['fundraising', ['donationSummary', 'receipts']],
      ['other', ['cashbook']],
    ]);
    expect(sections[0]?.reports[0]?.link).toBe('/reports/donationSummary');
  });

  it('keeps a collapsed group closed', () => {
    expect(reportSections(reports, new Set(['fundraising']), 'Other').map((s) => s.collapsed)).toEqual([true, false]);
  });
});
