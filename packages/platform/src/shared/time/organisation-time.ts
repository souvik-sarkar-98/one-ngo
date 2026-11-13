/** The organisation's time zone. Record dates belong to its day, not to the UTC day. */
export const ORGANISATION_TIME_ZONE = 'Asia/Kolkata';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The day `at` falls on in `timeZone`, as `YYYY-MM-DD`. */
export function dateIn(timeZone: string, at: Date = new Date()): string {
  const parts = formatter(timeZone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Today in the organisation's time zone, as `YYYY-MM-DD`. Between midnight and
 * 05:30 in India the UTC day is still yesterday, so a payment entered then must
 * not be read as dated in the future.
 */
export function organisationToday(at: Date = new Date()): string {
  return dateIn(ORGANISATION_TIME_ZONE, at);
}
