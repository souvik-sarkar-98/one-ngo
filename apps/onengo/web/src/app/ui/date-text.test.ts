import { describe, expect, it } from 'vitest';
import { formatDate } from '../core/i18n/i18n';
import { formatFieldDate, parseFieldDate } from './date-text';

describe('dates in the form fields', () => {
  it('writes a picked date day first, as the rest of the app does', () => {
    expect(formatFieldDate(new Date(2026, 10, 10), 'date')).toBe('10 Nov 2026');
    expect(formatFieldDate(new Date(2026, 0, 1), 'date')).toBe('01 Jan 2026');
    expect(formatFieldDate(new Date(2026, 10, 10), 'date')).toBe(formatDate('2026-11-10'));
  });

  it('keeps the day the person picked, whatever the browser time zone', () => {
    expect(formatFieldDate(new Date(2026, 10, 10, 0, 0), 'date')).toBe('10 Nov 2026');
    expect(formatFieldDate(new Date(2026, 10, 10, 23, 30), 'date')).toBe('10 Nov 2026');
  });

  it('writes the calendar labels and times', () => {
    expect(formatFieldDate(new Date(2026, 10, 10), 'monthYear')).toBe('Nov 2026');
    expect(formatFieldDate(new Date(2026, 10, 10), 'longDate')).toBe('10 November 2026');
    expect(formatFieldDate(new Date(2026, 10, 10), 'longMonthYear')).toBe('November 2026');
    expect(formatFieldDate(new Date(2026, 10, 10, 9, 5), 'time')).toBe('09:05');
  });

  it('writes a date in the language in use', () => {
    expect(formatFieldDate(new Date(2026, 10, 10), 'date', 'hi-IN-u-nu-latn')).toContain('10');
    expect(formatFieldDate(new Date(2026, 10, 10), 'date', 'hi-IN-u-nu-latn')).toContain('2026');
  });

  it('says nothing for a date that is not a date', () => {
    expect(formatFieldDate(new Date(Number.NaN), 'date')).toBe('');
  });

  it('reads a typed all-numeric date day first', () => {
    expect(parseFieldDate('10/11/2026')).toEqual(new Date(2026, 10, 10));
    expect(parseFieldDate('10-11-2026')).toEqual(new Date(2026, 10, 10));
    expect(parseFieldDate('1.2.2026')).toEqual(new Date(2026, 1, 1));
  });

  it('refuses a day that is not in that month, and leaves other wording to the browser', () => {
    expect(parseFieldDate('31/11/2026')).toBeNull();
    expect(parseFieldDate('10 Nov 2026')).toBeNull();
    expect(parseFieldDate('')).toBeNull();
  });
});
