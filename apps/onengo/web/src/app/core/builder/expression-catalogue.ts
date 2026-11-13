import { analyseExpression, EXPRESSION_FUNCTIONS, ExpressionError, type ValueType } from '../server';
import type { Params } from '../i18n/i18n';
import type { RecordTypeBody, RecordView } from '../models';

export type { ValueType };

/** Where an expression is used; it decides which names the expression can read. */
export type ExpressionContext = 'record' | 'action' | 'automation' | 'template' | 'posting';

const RECORD_ROOTS = ['record', 'previous', 'status', 'previousStatus', 'workflow', 'states', 'user'];
export const EXPRESSION_ROOTS: Record<ExpressionContext, readonly string[]> = {
  record: RECORD_ROOTS,
  posting: RECORD_ROOTS,
  action: [...RECORD_ROOTS, 'input'],
  template: [...RECORD_ROOTS, 'input'],
  automation: ['record', 'status', 'previousStatus'],
};

/** Readable on every record besides its fields. */
const RECORD_EXTRAS = ['id', 'number'];

const FIELD_VALUE: Record<string, ValueType> = {
  number: 'number',
  money: 'number',
  date: 'date',
  boolean: 'boolean',
  multiChoice: 'list',
  file: 'list',
  location: 'object',
  signature: 'object',
};

/** Arguments shown for each function. A function without an entry is still listed, as `name(…)`. */
const ARGS: Record<string, string> = {
  len: 'x',
  isEmpty: 'x',
  coalesce: 'a, b',
  contains: 'list, x',
  lower: 'text',
  upper: 'text',
  trim: 'text',
  round: 'x, 2',
  abs: 'x',
  min: 'a, b',
  max: 'a, b',
  today: '',
  now: '',
  daysBetween: 'a, b',
  addDays: 'date, n',
  text: 'x',
  number: 'x',
  sum: 'list, field',
  avg: 'list, field',
  count: 'list',
  formatMoney: 'amount',
  formatDate: 'date',
  inWords: 'amount',
};

/** The functions an expression can call, as the server's evaluator defines them. */
export const FUNCTION_NAMES: readonly string[] = EXPRESSION_FUNCTIONS;

export function functionArgs(name: string): string | undefined {
  return ARGS[name];
}

/** What an expression is written about: the published record type and the keys of its workflows. */
export interface ExpressionSubject {
  recordType: RecordTypeBody | null;
  workflows: string[];
}

export const NO_SUBJECT: ExpressionSubject = { recordType: null, workflows: [] };

/** `field`: the record now; `previous`: before the change; `person`: who is acting. */
export type EntryKind = 'field' | 'previous' | 'status' | 'state' | 'person' | 'input' | 'function';

export interface CatalogueEntry {
  /** What is written: `record.amount`, `states.kyc`, or a function's name. */
  name: string;
  /** What is shown: the name, or `round(x, 2)` for a function. */
  code: string;
  kind: EntryKind;
  valueType: ValueType;
  /** The field's own label from its definition. */
  label?: string;
  /** Screen text describing the entry. */
  note?: { key: string; params?: Params };
}

/** Everything an expression can read in this context, then the functions. */
export function expressionCatalogue(subject: ExpressionSubject, context: ExpressionContext = 'record', input: readonly string[] = []): CatalogueEntry[] {
  const roots = new Set(EXPRESSION_ROOTS[context]);
  const fields = subject.recordType?.fields ?? [];
  const out: CatalogueEntry[] = [];
  const add = (root: string, e: Omit<CatalogueEntry, 'code'>) => roots.has(root) && out.push({ ...e, code: e.name });
  for (const f of fields) add('record', { name: `record.${f.key}`, kind: 'field', valueType: FIELD_VALUE[f.type] ?? 'text', label: f.label });
  for (const x of RECORD_EXTRAS) {
    if (fields.some((f) => f.key === x)) continue;
    add('record', { name: `record.${x}`, kind: 'field', valueType: 'text', note: { key: `ui.expression.notes.record.${x}` } });
  }
  add('status', { name: 'status', kind: 'status', valueType: 'text', note: { key: 'ui.expression.notes.status' } });
  add('previousStatus', { name: 'previousStatus', kind: 'status', valueType: 'text', note: { key: 'ui.expression.notes.previousStatus' } });
  add('workflow', { name: 'workflow', kind: 'status', valueType: 'text', note: { key: 'ui.expression.notes.workflow' } });
  for (const w of subject.workflows) add('states', { name: `states.${w}`, kind: 'state', valueType: 'text', note: { key: 'ui.expression.notes.state', params: { workflow: w } } });
  add('user', { name: 'user.id', kind: 'person', valueType: 'text', note: { key: 'ui.expression.notes.user.id' } });
  add('user', { name: 'user.roles', kind: 'person', valueType: 'list', note: { key: 'ui.expression.notes.user.roles' } });
  for (const k of input) add('input', { name: `input.${k}`, kind: 'input', valueType: 'unknown', note: { key: 'ui.expression.notes.input' } });
  for (const f of fields) {
    add('previous', { name: `previous.${f.key}`, kind: 'previous', valueType: FIELD_VALUE[f.type] ?? 'text', label: f.label, note: { key: 'ui.expression.notes.previous', params: { label: f.label } } });
  }
  for (const name of FUNCTION_NAMES) {
    const args = ARGS[name];
    out.push({ name, code: `${name}(${args ?? '…'})`, kind: 'function', valueType: analyseExpression(`${name}()`).resultType, note: { key: `ui.expression.fn.${name}` } });
  }
  return out;
}

// ------------------------------------------------------------ suggestions

/** The word being typed at the cursor, e.g. `record.am`, and the stretch it replaces. */
export interface WordAt {
  from: number;
  to: number;
  word: string;
}

export function wordAt(source: string, cursor: number): WordAt {
  let from = cursor;
  while (from > 0 && /[A-Za-z0-9_.]/.test(source[from - 1]!)) from--;
  let to = cursor;
  while (to < source.length && /[A-Za-z0-9_]/.test(source[to]!)) to++;
  return { from, to, word: source.slice(from, cursor) };
}

/** Whether the cursor sits inside a quoted text. */
export function inText(source: string, cursor: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < cursor && i < source.length; i++) {
    const ch = source[i]!;
    if (quote && ch === '\\') i++;
    else if (quote && ch === quote) quote = null;
    else if (!quote && (ch === "'" || ch === '"')) quote = ch;
  }
  return quote !== null;
}

export interface Suggestions extends WordAt {
  items: CatalogueEntry[];
}

/**
 * Entries matching the word at the cursor: names starting with it first, then
 * names whose last part starts with it (`amo` → `record.amount`), then names
 * or field labels containing it. Nothing inside quoted text or numbers;
 * `explicit` (Ctrl+Space) suggests even before anything is typed.
 */
export function suggest(source: string, cursor: number, catalogue: readonly CatalogueEntry[], opts: { explicit?: boolean; limit?: number } = {}): Suggestions | null {
  if (inText(source, cursor)) return null;
  const at = wordAt(source, cursor);
  if ((!at.word && !opts.explicit) || /^[0-9]/.test(at.word)) return null;
  const q = at.word.toLowerCase();
  const last = q.includes('.') ? null : q;
  const rank = (e: CatalogueEntry): number => {
    const name = e.name.toLowerCase();
    if (name === q) return -1;
    if (name.startsWith(q)) return 0;
    if (last && name.split('.').pop()!.startsWith(last)) return 1;
    if (name.includes(q) || (!!e.label && e.label.toLowerCase().includes(q))) return 2;
    return -1;
  };
  const items = catalogue
    .map((e, i) => ({ e, i, r: rank(e) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, opts.limit ?? 8)
    .map((x) => x.e);
  return items.length ? { ...at, items } : null;
}

/** A change to the text with where the cursor goes next. */
export interface Edit {
  source: string;
  cursor: number;
}

/** What writing an entry adds: a function gets its brackets, with the cursor between them when it takes arguments. */
function written(entry: CatalogueEntry, next: string): { text: string; cursor: number } {
  if (entry.kind !== 'function' || next === '(') return { text: entry.name, cursor: entry.name.length };
  const takes = ARGS[entry.name] !== '';
  return { text: `${entry.name}()`, cursor: entry.name.length + (takes ? 1 : 2) };
}

/** Replaces the word being typed with the chosen entry. */
export function applySuggestion(source: string, range: Pick<WordAt, 'from' | 'to'>, entry: CatalogueEntry): Edit {
  const w = written(entry, source[range.to] ?? '');
  return { source: source.slice(0, range.from) + w.text + source.slice(range.to), cursor: range.from + w.cursor };
}

/**
 * Inserts an entry at the cursor, as the field and function buttons do. A
 * half-typed name of the entry is completed; after another name a space is
 * put between them.
 */
export function insertEntry(source: string, cursor: number, entry: CatalogueEntry): Edit {
  const at = Math.min(Math.max(cursor, 0), source.length);
  const word = wordAt(source, at);
  if (word.word && entry.name.toLowerCase().startsWith(word.word.toLowerCase())) return applySuggestion(source, word, entry);
  const gap = /[A-Za-z0-9_)'"]/.test(source[at - 1] ?? '') ? ' ' : '';
  return applySuggestion(source.slice(0, at) + gap + source.slice(at), { from: at + gap.length, to: at + gap.length }, entry);
}

// ---------------------------------------------------------- did you mean

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The nearest candidate when it is close enough to be a likely typo; the same rule the server's check uses. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

/** Replaces the name starting at `position` with the suggested one ("did you mean"). */
export function replaceWordAt(source: string, position: number, word: string): Edit | null {
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(position));
  if (!m) return null;
  return { source: source.slice(0, position) + word + source.slice(position + m[0].length), cursor: position + word.length };
}

/** The text around a problem's position, to point at it: the name there, else one character, else a space at the end. */
export function errorSpan(source: string, position: number): { before: string; at: string; after: string } {
  const p = Math.min(Math.max(position, 0), source.length);
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(p));
  const len = m ? m[0].length : p < source.length ? 1 : 0;
  return { before: source.slice(0, p), at: source.slice(p, p + len) || ' ', after: source.slice(p + len) };
}

// ------------------------------------------------------------ local check

export interface ExpressionCheck {
  ok: boolean;
  error?: string;
  position?: number;
  /** The name probably meant, at `position`. */
  suggestion?: string;
  resultType?: ValueType;
}

/**
 * The server's expression check without the server: the same parser, names
 * per context, fields of the record type and workflows. The server's answer
 * is the one the editor shows; this serves the in-memory gateway.
 */
export function localCheck(source: string, subject: ExpressionSubject, context: ExpressionContext = 'record', input?: readonly string[]): ExpressionCheck {
  const type = subject.recordType;
  const fields = new Map(type?.fields.map((f) => [f.key, f]) ?? []);
  const typeOf = (path: string[]): ValueType => {
    const [root, name] = path;
    if (path.length === 1) return root === 'status' || root === 'previousStatus' || root === 'workflow' ? 'text' : root === 'user' || root === 'record' ? 'object' : 'unknown';
    if (path.length > 2) return 'unknown';
    if (root === 'record' || root === 'previous') {
      if (RECORD_EXTRAS.includes(name!) && !fields.has(name!)) return 'text';
      const f = fields.get(name!);
      return f ? (FIELD_VALUE[f.type] ?? 'text') : 'unknown';
    }
    if (root === 'states') return 'text';
    if (root === 'user') return name === 'roles' ? 'list' : name === 'id' ? 'text' : 'unknown';
    return 'unknown';
  };
  let info;
  try {
    info = analyseExpression(source, typeOf);
  } catch (e) {
    if (e instanceof ExpressionError) return { ok: false, error: e.message, position: e.position };
    throw e;
  }
  const unknown = (message: string, word: string, candidates: readonly string[], position: number): ExpressionCheck => {
    const suggestion = closest(word, candidates);
    return { ok: false, error: suggestion ? `${message} Did you mean '${suggestion}'?` : message, position, ...(suggestion ? { suggestion } : {}) };
  };
  const roots = EXPRESSION_ROOTS[context];
  for (const v of info.variables) {
    const [root, name] = v.path as [string, string | undefined];
    if (!roots.includes(root)) return unknown(`Unknown name '${root}'.`, root, roots, v.position);
    if (name === undefined) continue;
    const at = v.position + root.length + 1;
    if ((root === 'record' || root === 'previous') && type && !fields.has(name) && !RECORD_EXTRAS.includes(name)) {
      return unknown(`${type.label} has no field '${name}'.`, name, [...fields.keys()], at);
    }
    if (root === 'states' && type && !subject.workflows.includes(name)) return unknown(`${type.label} has no workflow '${name}'.`, name, subject.workflows, at);
    if (root === 'user' && name !== 'id' && name !== 'roles') return unknown(`'user' has no '${name}'.`, name, ['id', 'roles'], at);
    if (root === 'input' && input && !input.includes(name)) return unknown(`The form has no field '${name}'.`, name, input, at);
  }
  return { ok: true, resultType: info.resultType };
}

// ---------------------------------------------------------- sample values

/** One value an expression reads that "Try it" asks for, e.g. `record.amount`. */
export interface SampleSlot {
  path: string;
  /** How to enter it. */
  input: 'number' | 'date' | 'boolean' | 'text';
  /** The field's label, when it is a field. */
  label?: string;
  /** Not a known field, so numbers and true or false are read as such. */
  free?: true;
}

/** What "Try it" evaluates on instead of a real record; the person is always the signed-in one. */
export interface ExpressionSample {
  record?: Record<string, unknown>;
  previous?: Record<string, unknown>;
  status?: string;
  previousStatus?: string;
  workflow?: string;
  states?: Record<string, string>;
  input?: Record<string, unknown>;
}

const SAMPLE_INPUT: Record<string, SampleSlot['input']> = { number: 'number', money: 'number', date: 'date', boolean: 'boolean' };

/** The values the expression reads, in the order it reads them; `user.*` comes from the signed-in person. Unreadable text gives none. */
export function sampleSlots(source: string, subject: ExpressionSubject): SampleSlot[] | null {
  let info;
  try {
    info = analyseExpression(source);
  } catch {
    return null;
  }
  const fields = new Map(subject.recordType?.fields.map((f) => [f.key, f]) ?? []);
  const out: SampleSlot[] = [];
  for (const v of info.variables) {
    const [root, name] = v.path;
    const single = root === 'status' || root === 'previousStatus' || root === 'workflow';
    const keyed = root === 'record' || root === 'previous' || root === 'states' || root === 'input';
    if (!(single && v.path.length === 1) && !(keyed && v.path.length === 2)) continue;
    const path = v.path.join('.');
    if (out.some((s) => s.path === path)) continue;
    const f = root === 'record' || root === 'previous' ? fields.get(name!) : undefined;
    const free = root === 'input' || (!f && (root === 'record' || root === 'previous') && !RECORD_EXTRAS.includes(name!));
    out.push({ path, input: f ? (SAMPLE_INPUT[f.type] ?? 'text') : 'text', ...(f ? { label: f.label } : {}), ...(free ? { free: true as const } : {}) });
  }
  return out;
}

function sampleValue(slot: SampleSlot, text: string): unknown {
  if (slot.input === 'boolean') return text === 'true';
  if (slot.free && (text === 'true' || text === 'false')) return text === 'true';
  if (slot.input === 'number' || (slot.free && /^-?\d+(\.\d+)?$/.test(text.trim()))) {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) ? n : text;
  }
  return text;
}

/** Sample values as the try API takes them; blank values are left out, so they read as empty. */
export function sampleScope(slots: readonly SampleSlot[], values: Readonly<Record<string, string>>): ExpressionSample {
  const out: ExpressionSample = {};
  for (const s of slots) {
    const text = values[s.path] ?? '';
    if (text === '' && s.input !== 'boolean') continue;
    const [root, key] = s.path.split('.') as [string, string | undefined];
    const value = sampleValue(s, text);
    if (root === 'status' || root === 'previousStatus' || root === 'workflow') out[root] = String(value);
    else if (root === 'states') out.states = { ...out.states, [key!]: String(value) };
    else if (root === 'record' || root === 'previous' || root === 'input') out[root] = { ...out[root], [key!]: value };
  }
  return out;
}

/** A value as it is typed into a sample box. */
export function sampleText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** A real record's values for the slots, so they can be seen and edited; it has no previous version. */
export function sampleFromRecord(slots: readonly SampleSlot[], record: RecordView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of slots) {
    const [root, key] = s.path.split('.') as [string, string | undefined];
    let v: unknown = null;
    if (root === 'record') v = key === 'id' ? record.id : key === 'number' && !('number' in record.data) ? record.number : record.data[key!];
    else if (root === 'status') v = record.status;
    else if (root === 'workflow') v = record.workflow;
    else if (root === 'states') v = record.states?.[key!] ?? (record.workflow === key ? record.status : null);
    out[s.path] = sampleText(v);
  }
  return out;
}

/** How a record is named in the "Try it" picker: its number and title. */
export function recordLabel(type: RecordTypeBody | null, record: RecordView): string {
  const title = type?.titleField ? record.data[type.titleField] : undefined;
  return [record.number, typeof title === 'string' || typeof title === 'number' ? String(title) : ''].filter(Boolean).join(' · ') || record.id;
}

/** The type of a value an expression gave, as the server reports it. */
export function valueTypeOf(v: unknown): ValueType {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? 'date' : 'text';
  return Array.isArray(v) ? 'list' : 'object';
}

/** A result as code: texts quoted, lists and objects as JSON. */
export function resultText(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
