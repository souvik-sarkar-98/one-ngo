import { describe, expect, it } from 'vitest';
import { missingParameters, parameterFields, parameterQuery, parameterSummary, parameterValues, paramsFromQuery, type ReportParameter } from './report-files';

const PARAMS: ReportParameter[] = [
  { key: 'year', label: 'Financial year', type: 'text', required: true },
  { key: 'fund', label: 'Fund', type: 'choice', choices: [{ value: 'all', label: 'All funds' }, { value: 'edu', label: 'Education fund' }] },
  { key: 'from', label: 'From', type: 'date', required: true },
  { key: 'min', label: 'Minimum', type: 'money' },
  { key: 'paidOnly', label: 'Paid only', type: 'boolean' },
];

describe('report parameters', () => {
  it('draws each parameter as a create-panel field', () => {
    expect(parameterFields(PARAMS).map((f) => [f.key, f.type, f.required])).toEqual([
      ['year', 'text', true],
      ['fund', 'select', false],
      ['from', 'date', true],
      ['min', 'number', false],
      ['paidOnly', 'boolean', false],
    ]);
    expect(parameterFields(PARAMS)[1]?.options).toEqual([{ key: 'all', label: 'All funds' }, { key: 'edu', label: 'Education fund' }]);
  });

  it('reads panel values as the report expects, leaving blanks out', () => {
    const values = { year: '2026-27', fund: '', from: '2026-04-01', min: '500', paidOnly: true };
    expect(parameterValues(PARAMS, values)).toEqual({ year: '2026-27', from: '2026-04-01', min: 500, paidOnly: true });
    expect(missingParameters(PARAMS, { year: ' ' }, 'Required')).toEqual({ year: 'Required', from: 'Required' });
  });

  it('keeps the values in the address for the preview and back', () => {
    const query = parameterQuery({ year: '2026-27', min: 500, paidOnly: true });
    expect(query).toEqual({ year: '2026-27', min: '500', paidOnly: 'true' });
    expect(paramsFromQuery(PARAMS, (name) => query[name] ?? null)).toEqual({ year: '2026-27', min: 500, paidOnly: true });
  });

  it('sums up a published file’s parameters on one line', () => {
    const day = (iso: string) => `day(${iso})`;
    expect(parameterSummary(PARAMS, { year: '2026-27', fund: 'all', from: '2026-04-01', paidOnly: true }, day)).toBe(
      '2026-27 · All funds · From day(2026-04-01) · Paid only',
    );
    expect(parameterSummary(PARAMS, {}, day)).toBe('');
  });
});
