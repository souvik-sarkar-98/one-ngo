/** The first day a financial record dated `date` (`YYYY-MM-DD`) is outside the retention period. */
export function financialRetainedUntil(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
