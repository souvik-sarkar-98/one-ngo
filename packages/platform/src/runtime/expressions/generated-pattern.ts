/** One piece of a generated value: fixed text, the year and month of a date field, the first letter of a text field, or the counter. */
export type GeneratedPart =
  | { kind: 'text'; text: string }
  | { kind: 'yymm'; field: string }
  | { kind: 'initial'; field: string }
  | { kind: 'seq'; width: number };

const TOKEN = /\{(yymm|initial):([a-z][a-zA-Z0-9_]{0,62})\}|\{seq:(\d{1,2})\}/g;
const LITERAL = /^[A-Za-z0-9-]*$/;
/** The widest counter a pattern may use. */
export const MAX_COUNTER_WIDTH = 6;

/**
 * Splits a generated-field pattern into its parts, or says what is wrong with it.
 * Tokens: {yymm:<date field>}, {initial:<text field>} and exactly one {seq:N} counter, last.
 */
export function parseGenerated(pattern: string): GeneratedPart[] | string {
  const parts: GeneratedPart[] = [];
  let last = 0;
  for (const m of pattern.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    const text = pattern.slice(last, at);
    if (!LITERAL.test(text)) return 'Fixed text may use only letters, digits and -.';
    if (text) parts.push({ kind: 'text', text });
    last = at + m[0].length;
    if (m[3] !== undefined) {
      const width = Number(m[3]);
      if (width < 1 || width > MAX_COUNTER_WIDTH) return `The counter needs between 1 and ${MAX_COUNTER_WIDTH} digits.`;
      parts.push({ kind: 'seq', width });
    } else {
      parts.push(m[1] === 'yymm' ? { kind: 'yymm', field: m[2]! } : { kind: 'initial', field: m[2]! });
    }
  }
  const tail = pattern.slice(last);
  if (!LITERAL.test(tail)) return 'Fixed text may use only letters, digits and -.';
  if (tail) parts.push({ kind: 'text', text: tail });
  if (parts.filter((p) => p.kind === 'seq').length !== 1) return 'Use exactly one {seq:N} counter.';
  if (parts.at(-1)?.kind !== 'seq') return 'Put the {seq:N} counter at the end.';
  return parts;
}

/** The year and month of an ISO date as YYMM, or null when the value is not an ISO date. */
export function yymmOf(isoDate: unknown): string | null {
  return typeof isoDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? isoDate.slice(2, 4) + isoDate.slice(5, 7) : null;
}

/** The first letter of a name, upper-cased; X when it is not a Latin letter. */
export function initialOf(value: unknown): string {
  const c = String(value ?? '').trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(c) ? c : 'X';
}

/**
 * The counter digits for the n-th value (counting from 1) under one prefix: a running
 * number padded with zeros to the width, so 001, 002, 003. Past the width the plain count
 * is used with more digits, which cannot equal any value within the width.
 */
export function counterDigits(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
