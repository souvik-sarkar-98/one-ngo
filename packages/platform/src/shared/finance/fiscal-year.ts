/** The organisation setting that holds the financial year start month. */
export const FY_START_SETTING = 'finance.financialYearStartMonth';

/** The financial year starts on 1 April unless the organisation chose another month. */
export const DEFAULT_FY_START_MONTH = 4;

/**
 * Financial year label for a date: the starting year and the next year's last
 * two digits when the year spans two calendar years (2026-10-18 -> "2026-27"
 * from April, "2026-27" from July), the calendar year alone from January ("2026").
 */
export function fiscalYearKey(isoDate: string, startMonth = DEFAULT_FY_START_MONTH): string {
  const [y, m] = isoDate.split('-').map(Number) as [number, number];
  if (startMonth === 1) return String(y);
  const start = m >= startMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Whether `key` is a financial year label for years starting in `startMonth`. */
export function isFiscalYearKey(key: string, startMonth = DEFAULT_FY_START_MONTH): boolean {
  if (startMonth === 1) return /^\d{4}$/.test(key);
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return !!m && Number(m[2]) === (Number(m[1]) + 1) % 100;
}

/** The counter period of a numbering: one per financial year, or one for all time. */
export function numberingPeriod(reset: 'fiscal_year' | 'never' | undefined, fy: string): string {
  return reset === 'never' ? 'all' : fy;
}

/** The first and last day of the financial year `key` (as `fiscalYearKey` gives it for `startMonth`). */
export function fiscalYearBounds(key: string, startMonth = DEFAULT_FY_START_MONTH): { startsOn: string; endsOn: string } {
  const start = Number(key.slice(0, 4));
  const mm = String(startMonth).padStart(2, '0');
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? start : start + 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return {
    startsOn: `${start}-${mm}-01`,
    endsOn: `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}
