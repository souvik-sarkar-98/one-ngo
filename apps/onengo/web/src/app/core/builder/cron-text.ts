import { currentTranslator, intlLocale, t } from '../i18n/i18n';

export type CronText = { ok: true; text: string } | { ok: false; error: string };

/** Minute, hour, day of the month, month, day of the week: the server's cron fields and ranges. */
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];
const MAX_TIMES = 6;

/** A field's values; `null` for `*`. */
type Field = number[] | null;

function parseField(field: string, [min, max]: [number, number]): Field | undefined {
  if (field === '*') return null;
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) return undefined;
    const step = m[3] ? Number(m[3]) : 1;
    const start = m[1] === '*' ? min : Number(m[1]);
    const end = m[2] ? Number(m[2]) : m[1] === '*' || m[3] ? max : start;
    if (step < 1 || start < min || end > max || start > end) return undefined;
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** The gap between values spread evenly from the start of the range to its end, e.g. 15 for `*\/15` minutes. */
function evenStep(values: number[], [min, max]: [number, number]): number | null {
  if (values.length < 2 || values[0] !== min) return null;
  const step = values[1]! - values[0]!;
  const even = values.every((v, i) => v === min + i * step);
  return even && max - values[values.length - 1]! < step ? step : null;
}

const contiguous = (values: number[]) => values.length > 2 && values.every((v, i) => i === 0 || v === values[i - 1]! + 1);
const two = (n: number) => String(n).padStart(2, '0');

/** A five-field cron schedule read out in plain words, in UTC as the server runs it. */
export function cronText(source: string): CronText {
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { ok: false, error: t('ui.builder.cron.fields') };
  const fields: Field[] = [];
  for (let i = 0; i < 5; i++) {
    const f = parseField(parts[i]!, RANGES[i]!);
    if (f === undefined) return { ok: false, error: t('ui.builder.cron.bad', { part: parts[i]!, n: String(i + 1), min: String(RANGES[i]![0]), max: String(RANGES[i]![1]) }) };
    fields.push(f);
  }
  const [minute, hour, dom, month, dow] = fields as [Field, Field, Field, Field, Field];
  const locale = intlLocale(currentTranslator().locale);
  const list = (items: string[]) => new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
  const name = (options: Intl.DateTimeFormatOptions, date: (n: number) => Date) => (n: number) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date(n));
  const weekday = name({ weekday: 'long' }, (n) => new Date(Date.UTC(2026, 0, 4 + n)));
  const monthName = name({ month: 'long' }, (n) => new Date(Date.UTC(2026, n - 1, 1)));
  const numbers = (values: number[]) => list(values.map(String));
  const minuteStep = minute ? evenStep(minute, RANGES[0]!) : null;
  const hourStep = hour ? evenStep(hour, RANGES[1]!) : null;

  let time: string;
  if (!minute && !hour) time = t('ui.builder.cron.everyMinute');
  else if (!hour && minuteStep) time = t('ui.builder.cron.everyMinutes', { n: String(minuteStep) });
  else if (!minute) time = t('ui.builder.cron.everyMinuteOfHours', { hours: numbers(hour!) });
  else if (!hour && minute.length === 1) time = t('ui.builder.cron.hourly', { minute: String(minute[0]) });
  else if (hour && minute.length === 1 && hourStep && hour.length > MAX_TIMES) time = t('ui.builder.cron.everyHours', { n: String(hourStep), minute: String(minute[0]) });
  else if (hour && minute.length === 1 && contiguous(hour) && hour.length > MAX_TIMES) {
    time = t('ui.builder.cron.hourRange', { minute: String(minute[0]), from: `${two(hour[0]!)}:00`, to: `${two(hour[hour.length - 1]!)}:00` });
  } else if (hour && minute.length * hour.length <= MAX_TIMES) {
    time = t('ui.builder.cron.at', { times: list(hour.flatMap((h) => minute.map((m) => `${two(h)}:${two(m)}`))) });
  } else time = hour ? t('ui.builder.cron.atMinutesOfHours', { minutes: numbers(minute), hours: numbers(hour) }) : t('ui.builder.cron.atMinutes', { minutes: numbers(minute) });

  const weekdays = dow?.join() === '1,2,3,4,5';
  const onDow = dow && (weekdays ? t('ui.builder.cron.weekdays') : t('ui.builder.cron.onDays', { days: list(dow.map(weekday)) }));
  const onDom = dom && t('ui.builder.cron.onDates', { dates: numbers(dom) });
  const days = onDom && onDow ? t('ui.builder.cron.either', { a: onDom, b: onDow }) : (onDom ?? onDow ?? t('ui.builder.cron.everyDay'));
  const months = month && t('ui.builder.cron.inMonths', { months: list(month.map(monthName)) });
  return { ok: true, text: t('ui.builder.cron.utc', { text: [time, days, months].filter(Boolean).join(', ') }) };
}
