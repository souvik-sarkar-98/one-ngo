import { decimalOf, isDay, paise } from './money';

/**
 * Reading a bank's statement file in the browser. Banks all lay their CSV out differently, so the person says
 * which column is which; nothing leaves the browser until they confirm.
 */

export type ColumnRole = 'ignore' | 'date' | 'description' | 'amount' | 'moneyOut' | 'moneyIn' | 'reference';
export const COLUMN_ROLES: readonly ColumnRole[] = ['ignore', 'date', 'description', 'amount', 'moneyOut', 'moneyIn', 'reference'];

/** Which part of a written date comes first: day-month-year, month-day-year or year-month-day. */
export type DateOrder = 'dmy' | 'mdy' | 'ymd';
export const DATE_ORDERS: readonly DateOrder[] = ['dmy', 'mdy', 'ymd'];

/** One amount column (money out is negative), or separate columns for money out and money in. */
export type AmountStyle = 'single' | 'split';

export interface ImportSetup {
  /** The role of each column, by the heading the bank gave it. */
  roles: Record<string, ColumnRole>;
  dateOrder: DateOrder;
  amountStyle: AmountStyle;
}

/** The server takes at most this many lines in one request. */
export const IMPORT_CHUNK = 1000;

// ---------------------------------------------------------------- reading the file

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** The delimiter the first line uses most. */
function sniffDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let most = 0;
  for (const d of DELIMITERS) {
    const n = first.split(d).length - 1;
    if (n > most) {
      most = n;
      best = d;
    }
  }
  return best;
}

/** CSV text as rows of cells: quoted cells may hold the delimiter, quotes ("") and line breaks. Blank rows are dropped. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const delimiter = sniffDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== '')) rows.push(row.map((c) => c.trim()));
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}

// ---------------------------------------------------------------- one cell at a time

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n: number): string => String(n).padStart(2, '0');

function day(y: number, m: number, d: number): string | null {
  const iso = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  return isDay(iso) ? iso : null;
}

/** A written date as `2026-11-03`, or null when it is not a real date. Two-digit years are taken as 20xx. Month names are understood in any order setting. */
export function parseDate(text: string, order: DateOrder): string | null {
  const s = text.trim().replace(/[,]/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  // Drop a time of day that follows the date.
  const dateOnly = s.replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\s?[ap]m)?$/i, '');
  const named = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ](\d{2}|\d{4})$/.exec(dateOnly);
  if (named) {
    const m = MONTHS.indexOf(named[2]!.slice(0, 3).toLowerCase()) + 1;
    if (!m) return null;
    const y = Number(named[3]);
    return day(named[3]!.length === 2 ? 2000 + y : y, m, Number(named[1]));
  }
  const parts = /^(\d{1,4})[-/. ](\d{1,2})[-/. ](\d{1,4})$/.exec(dateOnly);
  if (!parts) return null;
  const [a, b, c] = [parts[1]!, parts[2]!, parts[3]!];
  if (order === 'ymd') return a.length === 4 ? day(Number(a), Number(b), Number(c)) : null;
  if (c.length !== 4 && c.length !== 2) return null;
  const y = c.length === 2 ? 2000 + Number(c) : Number(c);
  return order === 'dmy' ? day(y, Number(b), Number(a)) : day(y, Number(a), Number(b));
}

/**
 * An amount as a decimal such as `-23.60`, or null when it is not one. Understands thousands commas (also the
 * Indian 1,00,000 style), a ₹ or Rs sign, (brackets) or a leading minus for negative, and a trailing Dr or Cr.
 */
export function parseAmount(text: string): string | null {
  let s = text.trim();
  if (!s) return null;
  let negative = false;
  const bracketed = /^\((.*)\)$/.exec(s);
  if (bracketed) {
    negative = true;
    s = bracketed[1]!;
  }
  const suffix = /\s*(dr|cr)\.?$/i.exec(s);
  if (suffix) {
    if (suffix[1]!.toLowerCase() === 'dr') negative = !negative;
    s = s.slice(0, suffix.index);
  }
  s = s.replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/\s/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  s = s.replace(/^(₹|rs\.?|inr)/i, '');
  if (!/^(\d{1,3}(,\d{2,3})*|\d+)(\.\d+)?$/.test(s)) return null;
  s = s.replace(/,/g, '');
  const value = paise(s);
  if (Number.isNaN(value)) return null;
  return decimalOf(negative ? -value : value);
}

// ---------------------------------------------------------------- the person's choices

const GUESSES: [ColumnRole, RegExp][] = [
  ['reference', /(^|\b)(ref|chq|cheque|utr|instrument|transaction id|txn id)/i],
  ['moneyOut', /(debit|withdraw|paid out|money out|\bdr\b)/i],
  ['moneyIn', /(credit|deposit|paid in|money in|\bcr\b)/i],
  ['date', /(date|\bdt\b)/i],
  ['description', /(narration|description|particular|details|remark|transaction)/i],
  ['amount', /^(amount|amt)/i],
];

/** A first guess at what each column is, from its heading; the person corrects it. A repeated role is left for them. */
export function guessRoles(headers: string[]): Record<string, ColumnRole> {
  const roles: Record<string, ColumnRole> = {};
  const used = new Set<ColumnRole>();
  for (const h of headers) {
    // A heading such as "Value Date" is a date; "Balance" never matches and stays ignored.
    const hit = GUESSES.find(([role, re]) => re.test(h) && !used.has(role));
    roles[h] = hit ? hit[0] : 'ignore';
    if (hit) used.add(hit[0]);
  }
  return roles;
}

/** Which way round the dates are written, judged from the file: a part above 12 settles it. */
export function guessDateOrder(samples: string[]): DateOrder {
  let first = false;
  let second = false;
  for (const s of samples) {
    if (/^\d{4}\D/.test(s.trim())) return 'ymd';
    const m = /^(\d{1,2})\D(\d{1,2})\D/.exec(s.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) first = true;
    if (Number(m[2]) > 12) second = true;
  }
  return second && !first ? 'mdy' : 'dmy';
}

/** Setup for a file: the saved one where its headings are known, a guess for any new heading. */
export function initialSetup(headers: string[], rows: string[][], saved?: Partial<ImportSetup> | null): ImportSetup {
  const guessed = guessRoles(headers);
  const roles: Record<string, ColumnRole> = {};
  for (const h of headers) roles[h] = saved?.roles?.[h] && COLUMN_ROLES.includes(saved.roles[h]!) ? saved.roles[h]! : guessed[h]!;
  const dateIndex = headers.findIndex((h) => roles[h] === 'date');
  const split = Object.values(roles).includes('moneyOut') && Object.values(roles).includes('moneyIn');
  return {
    roles,
    dateOrder: saved?.dateOrder && DATE_ORDERS.includes(saved.dateOrder) ? saved.dateOrder : guessDateOrder(dateIndex < 0 ? [] : rows.slice(0, 50).map((r) => r[dateIndex] ?? '')),
    amountStyle: saved?.amountStyle ?? (split ? 'split' : 'single'),
  };
}

/** What stops the setup from being used, as plain words; null when it is complete. */
export function setupProblem(setup: ImportSetup, headers: string[]): 'date' | 'description' | 'amount' | 'twice' | null {
  const roles = headers.map((h) => setup.roles[h] ?? 'ignore');
  const count = (r: ColumnRole) => roles.filter((x) => x === r).length;
  if (COLUMN_ROLES.some((r) => r !== 'ignore' && count(r) > 1)) return 'twice';
  if (!count('date')) return 'date';
  if (!count('description')) return 'description';
  if (setup.amountStyle === 'single' ? !count('amount') : !count('moneyOut') || !count('moneyIn')) return 'amount';
  return null;
}

// ---------------------------------------------------------------- the lines

export interface ImportLine {
  date: string;
  /** Positive for money in, negative for money out. */
  amount: string;
  description: string;
  reference?: string;
}

export type LineProblem = 'date' | 'amount' | 'bothAmounts' | 'description';

export interface ParsedRow {
  /** Row number in the file, counting the heading as row 1. */
  row: number;
  line: ImportLine | null;
  problem: LineProblem | null;
  /** The cells as the file had them, for showing next to a problem. */
  raw: { date: string; description: string; amount: string; reference: string };
}

/** Every data row of the file as an import line, or the reason it cannot be one. */
export function readLines(headers: string[], rows: string[][], setup: ImportSetup): ParsedRow[] {
  const at = (role: ColumnRole) => headers.findIndex((h) => (setup.roles[h] ?? 'ignore') === role);
  const [iDate, iDesc, iAmount, iOut, iIn, iRef] = [at('date'), at('description'), at('amount'), at('moneyOut'), at('moneyIn'), at('reference')];
  return rows.map((cells, i): ParsedRow => {
    const cell = (index: number) => (index < 0 ? '' : (cells[index] ?? '').trim());
    const raw = {
      date: cell(iDate),
      description: cell(iDesc),
      amount: setup.amountStyle === 'single' ? cell(iAmount) : [cell(iIn) && `+${cell(iIn)}`, cell(iOut) && `-${cell(iOut)}`].filter(Boolean).join(' / '),
      reference: cell(iRef),
    };
    const fail = (problem: LineProblem): ParsedRow => ({ row: i + 2, line: null, problem, raw });

    const date = parseDate(raw.date, setup.dateOrder);
    if (!date) return fail('date');
    let amount: string | null;
    if (setup.amountStyle === 'single') amount = parseAmount(cell(iAmount));
    else {
      const out = cell(iOut) ? parseAmount(cell(iOut)) : '0.00';
      const inn = cell(iIn) ? parseAmount(cell(iIn)) : '0.00';
      if (out === null || inn === null) return fail('amount');
      const [o, n] = [Math.abs(paise(out)), Math.abs(paise(inn))];
      if (o && n) return fail('bothAmounts');
      amount = decimalOf(n - o);
    }
    if (amount === null || paise(amount) === 0) return fail('amount');
    if (!raw.description) return fail('description');
    return { row: i + 2, line: { date, amount, description: raw.description, ...(raw.reference && { reference: raw.reference }) }, problem: null, raw };
  });
}

/** The lines the server can take, from the rows that are fine. */
export const usableLines = (rows: ParsedRow[]): ImportLine[] => rows.flatMap((r) => (r.line ? [r.line] : []));

/** Splits a list into pieces of at most `size`, in order. */
export function chunks<T>(items: T[], size = IMPORT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------- remembering the setup

export const setupStorageKey = (tenant: string, accountKey: string): string => `onengo.statementSetup.${tenant}.${accountKey}`;

/** The setup saved for the account in this browser, or null when there is none or it is unreadable. */
export function readSetup(storage: Pick<Storage, 'getItem'>, key: string): Partial<ImportSetup> | null {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<ImportSetup>;
    const roles: Record<string, ColumnRole> = {};
    if (p.roles && typeof p.roles === 'object') for (const [h, r] of Object.entries(p.roles)) if (COLUMN_ROLES.includes(r as ColumnRole)) roles[h] = r as ColumnRole;
    return {
      roles,
      ...(p.dateOrder && DATE_ORDERS.includes(p.dateOrder) && { dateOrder: p.dateOrder }),
      ...((p.amountStyle === 'single' || p.amountStyle === 'split') && { amountStyle: p.amountStyle }),
    };
  } catch {
    return null;
  }
}

export function writeSetup(storage: Pick<Storage, 'setItem'>, key: string, setup: ImportSetup): void {
  try {
    storage.setItem(key, JSON.stringify(setup));
  } catch {
    // A full or blocked store only means the choice is not remembered.
  }
}
