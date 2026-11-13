export { DEFAULT_FY_START_MONTH, FY_START_SETTING, fiscalYearBounds, fiscalYearKey, isFiscalYearKey, numberingPeriod } from './fiscal-year.js';

/** Formats `DON/{fy}/{seq:5}` style patterns. */
export function formatNumber(pattern: string, values: { seq: number; fy: string; period: string }): string {
  return pattern.replace(/\{(seq|fy|period)(?::(\d+))?\}/g, (_m, name: string, width?: string) => {
    const raw = name === 'seq' ? String(values.seq) : name === 'fy' ? values.fy : values.period;
    return width ? raw.padStart(Number(width), '0') : raw;
  });
}
