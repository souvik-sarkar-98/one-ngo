import { currentTranslator, intlLocale } from '../core/i18n/i18n';

/** The wording a date picker asks for; `date-adapter.ts` maps the picker's display formats onto these. */
export type FieldDateStyle = 'date' | 'longDate' | 'monthYear' | 'longMonthYear' | 'time';

const PARTS: Record<FieldDateStyle, Intl.DateTimeFormatOptions> = {
  date: { day: '2-digit', month: 'short', year: 'numeric' },
  longDate: { day: '2-digit', month: 'long', year: 'numeric' },
  monthYear: { month: 'short', year: 'numeric' },
  longMonthYear: { month: 'long', year: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};

const DAY_FIRST = /^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4})$/;

/**
 * A picker's date the way the organisation writes it, day first, e.g. 10 Nov 2026, the
 * same as `formatDate` elsewhere. The date's own day is written, not the day it falls on in UTC.
 */
export function formatFieldDate(
  date: Date,
  style: FieldDateStyle,
  locale: string = intlLocale(currentTranslator().locale),
): string {
  if (Number.isNaN(date.getTime())) return '';
  const utc = new Date(0);
  utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  utc.setUTCHours(date.getHours(), date.getMinutes(), 0, 0);
  return new Intl.DateTimeFormat(locale, { ...PARTS[style], timeZone: 'UTC' }).format(utc);
}

/** A typed all-numeric date read day first, e.g. `10/11/2026` is 10 November; other wording is left to the browser. */
export function parseFieldDate(value: string): Date | null {
  const parts = DAY_FIRST.exec(value.trim());
  if (!parts) return null;
  const [day, month, year] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  const real = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return real ? date : null;
}
