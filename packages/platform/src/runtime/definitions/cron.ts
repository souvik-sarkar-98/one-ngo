/**
 * Five-field cron (minute hour day-of-month month day-of-week), evaluated in UTC.
 * Supports `*`, numbers, lists `1,15`, ranges `1-5`, and steps `*\/15`, `1-30/5`.
 * When both day fields are restricted, a day matches if either matches (POSIX).
 */
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

export interface CronSchedule {
  readonly source: string;
  matches(date: Date): boolean;
  /** Latest matching minute in (after, upTo], or null. */
  lastDueBetween(after: Date, upTo: Date): Date | null;
}

function parseField(field: string, [min, max]: [number, number]): Set<number> | null {
  if (field === '*') return null;
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Invalid cron field '${field}'`);
    const step = m[3] ? Number(m[3]) : 1;
    const start = m[1] === '*' ? min : Number(m[1]);
    const end = m[2] ? Number(m[2]) : m[1] === '*' || m[3] ? max : start;
    if (step < 1 || start < min || end > max || start > end) throw new Error(`Cron value out of range in '${field}'`);
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

export function parseCron(source: string): CronSchedule {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron needs five fields: minute hour day month weekday');
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, RANGES[i]!)) as (Set<number> | null)[];
  const has = (s: Set<number> | null | undefined, v: number) => !s || s.has(v);

  const matches = (d: Date) => {
    if (!has(minute, d.getUTCMinutes()) || !has(hour, d.getUTCHours()) || !has(month, d.getUTCMonth() + 1)) return false;
    const domOk = has(dom, d.getUTCDate());
    const dowOk = has(dow, d.getUTCDay());
    return dom && dow ? domOk || dowOk : domOk && dowOk;
  };

  return {
    source,
    matches,
    lastDueBetween(after, upTo) {
      const end = new Date(Math.floor(upTo.getTime() / 60_000) * 60_000);
      // Look back at most 31 days so a long outage does not scan forever.
      const floor = Math.max(after.getTime(), end.getTime() - 31 * 86_400_000);
      for (let t = end.getTime(); t > floor; t -= 60_000) {
        const d = new Date(t);
        if (matches(d)) return d;
      }
      return null;
    },
  };
}

export function checkCron(source: string): string | null {
  try {
    parseCron(source);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
