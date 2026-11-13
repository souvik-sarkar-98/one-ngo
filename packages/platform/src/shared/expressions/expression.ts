/**
 * Safe, side-effect-free expression language used by validation rules,
 * calculated fields, workflow guards, and posting rules.
 *
 *   literals      12  3.5  'text'  "text"  true  false  null
 *   variables     record.amount  user.id  status
 *   operators     + - * / %   == != < <= > >=   and or not   ! && ||   a ? b : c
 *   functions     see FUNCTIONS
 *
 * Only own properties of plain objects and arrays are readable, and there is no
 * way to call methods or reach prototypes.
 */

import { organisationToday } from '../time/organisation-time.js';

type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'var'; path: string[]; pos: number }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[] };

type Token = { k: 'num' | 'str' | 'id' | 'op' | 'end'; v: string; pos: number };

export class ExpressionError extends Error {
  constructor(
    message: string,
    /** Character offset in the source where parsing failed, when known. */
    readonly position?: number,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

const MAX_LENGTH = 2000;
const MAX_DEPTH = 64;
const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', ',', '.', '?', ':'];
const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new ExpressionError(`Unterminated text at ${i}`, i);
      out.push({ k: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected character '${ch}' at ${i}`, i);
    out.push({ k: 'op', v: op, pos: i });
    i += op.length;
  }
  out.push({ k: 'end', v: '', pos: src.length });
  return out;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.ternary();
    if (this.peek().k !== 'end') throw new ExpressionError(`Unexpected '${this.peek().v}' at ${this.peek().pos}`, this.peek().pos);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.i]!;
  }
  private next(): Token {
    return this.tokens[this.i++]!;
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.k === 'op' && t.v === v;
  }
  private isWord(v: string): boolean {
    const t = this.peek();
    return t.k === 'id' && t.v === v;
  }
  private expectOp(v: string): void {
    if (!this.isOp(v)) throw new ExpressionError(`Expected '${v}' at ${this.peek().pos}`, this.peek().pos);
    this.i++;
  }
  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new ExpressionError('Expression is nested too deeply', this.peek().pos);
  }

  private ternary(): Node {
    this.enter();
    const c = this.or();
    if (this.isOp('?')) {
      this.i++;
      const a = this.ternary();
      this.expectOp(':');
      const b = this.ternary();
      this.depth--;
      return { t: 'cond', c, a, b };
    }
    this.depth--;
    return c;
  }
  private or(): Node {
    let a = this.and();
    while (this.isOp('||') || this.isWord('or')) {
      this.i++;
      a = { t: 'bin', op: 'or', a, b: this.and() };
    }
    return a;
  }
  private and(): Node {
    let a = this.not();
    while (this.isOp('&&') || this.isWord('and')) {
      this.i++;
      a = { t: 'bin', op: 'and', a, b: this.not() };
    }
    return a;
  }
  private not(): Node {
    if (this.isOp('!') || this.isWord('not')) {
      this.i++;
      this.enter();
      const a = this.not();
      this.depth--;
      return { t: 'un', op: 'not', a };
    }
    return this.compare();
  }
  private compare(): Node {
    let a = this.additive();
    for (;;) {
      const t = this.peek();
      if (t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
        this.i++;
        a = { t: 'bin', op: t.v, a, b: this.additive() };
      } else return a;
    }
  }
  private additive(): Node {
    let a = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      a = { t: 'bin', op, a, b: this.multiplicative() };
    }
    return a;
  }
  private multiplicative(): Node {
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().v;
      a = { t: 'bin', op, a, b: this.unary() };
    }
    return a;
  }
  private unary(): Node {
    if (this.isOp('-')) {
      this.i++;
      this.enter();
      const a = this.unary();
      this.depth--;
      return { t: 'un', op: 'neg', a };
    }
    return this.primary();
  }
  private primary(): Node {
    const t = this.next();
    if (t.k === 'num') return { t: 'lit', v: Number(t.v) };
    if (t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'op' && t.v === '(') {
      const n = this.ternary();
      this.expectOp(')');
      return n;
    }
    if (t.k === 'id') {
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      if (this.isOp('(')) {
        this.i++;
        const args: Node[] = [];
        if (!this.isOp(')')) {
          do args.push(this.ternary());
          while (this.isOp(',') && this.next());
        }
        this.expectOp(')');
        if (!Object.hasOwn(FUNCTIONS, t.v)) throw new ExpressionError(`Unknown function '${t.v}'`, t.pos);
        return { t: 'call', name: t.v, args };
      }
      const path = [t.v];
      while (this.isOp('.')) {
        this.i++;
        const p = this.next();
        if (p.k !== 'id') throw new ExpressionError(`Expected a field name at ${p.pos}`, p.pos);
        path.push(p.v);
      }
      for (const p of path) if (BLOCKED.has(p)) throw new ExpressionError(`'${p}' is not allowed`, t.pos);
      return { t: 'var', path, pos: t.pos };
    }
    throw new ExpressionError(`Unexpected '${t.v}' at ${t.pos}`, t.pos);
  }
}

function isPlainContainer(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ExpressionError(`${what} needs a number`);
  return v;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function underThousand(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const rest = n % 10;
    return rest ? `${TENS[Math.floor(n / 10)]} ${ONES[rest]}` : TENS[Math.floor(n / 10)]!;
  }
  const rest = n % 100;
  const head = `${ONES[Math.floor(n / 100)]} hundred`;
  return rest ? `${head} ${underThousand(rest)}` : head;
}

/** Indian grouping: crore, lakh, thousand, then the rest. */
function words(n: number): string {
  if (n === 0) return 'zero';
  const parts: string[] = [];
  let rest = n;
  for (const [scale, name] of [
    [10_000_000, 'crore'],
    [100_000, 'lakh'],
    [1_000, 'thousand'],
  ] as const) {
    if (rest >= scale) {
      parts.push(`${words(Math.floor(rest / scale))} ${name}`);
      rest %= scale;
    }
  }
  if (rest) parts.push(underThousand(rest));
  return parts.join(' ');
}

function listed(v: unknown, field?: unknown): number[] {
  const items = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
  const out: number[] = [];
  for (const item of items) {
    const raw = typeof field === 'string' && item !== null && typeof item === 'object' && Object.hasOwn(item, field) ? (item as Record<string, unknown>)[field] : item;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function moneyText(v: unknown): string {
  const n = num(v, 'formatMoney');
  const sign = n < 0 ? '-' : '';
  const [whole, frac] = Math.abs(n).toFixed(2).split('.') as [string, string];
  const grouped = whole.length > 3 ? `${whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}` : whole;
  return `${sign}${grouped}.${frac}`;
}

const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  len: (v) => (typeof v === 'string' || Array.isArray(v) ? v.length : 0),
  isEmpty: (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0),
  coalesce: (...vs) => vs.find((v) => v !== null && v !== undefined) ?? null,
  contains: (h, n) => (typeof h === 'string' ? h.includes(String(n)) : Array.isArray(h) ? h.includes(n) : false),
  lower: (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  upper: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
  trim: (v) => (typeof v === 'string' ? v.trim() : v),
  round: (v, d = 0) => {
    const f = 10 ** num(d, 'round');
    return Math.round(num(v, 'round') * f) / f;
  },
  abs: (v) => Math.abs(num(v, 'abs')),
  min: (...vs) => Math.min(...vs.map((v) => num(v, 'min'))),
  max: (...vs) => Math.max(...vs.map((v) => num(v, 'max'))),
  today: () => organisationToday(),
  now: () => new Date().toISOString(),
  daysBetween: (a, b) => {
    const ms = Date.parse(String(b)) - Date.parse(String(a));
    if (Number.isNaN(ms)) throw new ExpressionError('daysBetween needs two dates');
    return Math.round(ms / 86_400_000);
  },
  addDays: (d, n) => {
    const t = Date.parse(String(d));
    if (Number.isNaN(t)) throw new ExpressionError('addDays needs a date');
    return new Date(t + num(n, 'addDays') * 86_400_000).toISOString().slice(0, 10);
  },
  text: (v) => (v === null || v === undefined ? '' : String(v)),
  number: (v) => (v === null || v === undefined || v === '' ? null : Number(v)),
  sum: (v, field) => listed(v, field).reduce((n, x) => n + x, 0),
  avg: (v, field) => {
    const xs = listed(v, field);
    return xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null;
  },
  count: (v) => (Array.isArray(v) ? v.length : v === null || v === undefined || v === '' ? 0 : 1),
  formatMoney: (v) => (v === null || v === undefined || v === '' ? '' : moneyText(v)),
  formatDate: (v) => {
    if (v === null || v === undefined || v === '') return '';
    const s = String(v);
    const d = /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : new Date(s);
    if (Number.isNaN(d.getTime())) throw new ExpressionError('formatDate needs a date');
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  },
  inWords: (v) => {
    const n = num(v, 'inWords');
    const paise = Math.round(Math.abs(n) * 100);
    if (!Number.isSafeInteger(paise) || paise > 10_000_000_000_000) throw new ExpressionError('inWords needs a smaller amount');
    const head = `${n < 0 ? 'minus ' : ''}${words(Math.trunc(paise / 100))}`;
    const rest = paise % 100;
    return rest ? `${head} and ${words(rest)} paise` : head;
  },
};

/** Names of the functions an expression can call. */
export const EXPRESSION_FUNCTIONS: readonly string[] = Object.freeze(Object.keys(FUNCTIONS));

function truthy(v: unknown): boolean {
  return !(v === null || v === undefined || v === false || v === 0 || v === '' || Number.isNaN(v));
}

function evaluate(n: Node, scope: Record<string, unknown>): unknown {
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'var': {
      let cur: unknown = scope;
      for (const p of n.path) {
        if (!isPlainContainer(cur) || !Object.hasOwn(cur, p)) return null;
        if (Array.isArray(cur) && !/^\d+$/.test(p)) return null;
        cur = cur[p];
      }
      return cur === undefined ? null : cur;
    }
    case 'un': {
      const a = evaluate(n.a, scope);
      return n.op === 'not' ? !truthy(a) : -num(a, 'minus');
    }
    case 'cond':
      return truthy(evaluate(n.c, scope)) ? evaluate(n.a, scope) : evaluate(n.b, scope);
    case 'call':
      return FUNCTIONS[n.name]!(...n.args.map((a) => evaluate(a, scope)));
    case 'bin': {
      if (n.op === 'and') return truthy(evaluate(n.a, scope)) && truthy(evaluate(n.b, scope));
      if (n.op === 'or') return truthy(evaluate(n.a, scope)) || truthy(evaluate(n.b, scope));
      const a = evaluate(n.a, scope);
      const b = evaluate(n.b, scope);
      switch (n.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '<':
        case '<=':
        case '>':
        case '>=': {
          if (a === null || b === null) return false;
          if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) {
            throw new ExpressionError(`Cannot compare ${typeof a} with ${typeof b}`);
          }
          const x = a as number | string;
          const y = b as number | string;
          return n.op === '<' ? x < y : n.op === '<=' ? x <= y : n.op === '>' ? x > y : x >= y;
        }
        case '+':
          if (typeof a === 'string' || typeof b === 'string') return `${a ?? ''}${b ?? ''}`;
          return num(a, 'plus') + num(b, 'plus');
        case '-':
          return num(a, 'minus') - num(b, 'minus');
        case '*':
          return num(a, 'times') * num(b, 'times');
        case '/': {
          const d = num(b, 'divide');
          if (d === 0) throw new ExpressionError('Division by zero');
          return num(a, 'divide') / d;
        }
        case '%':
          return num(a, 'modulo') % num(b, 'modulo');
      }
    }
  }
  throw new ExpressionError('Unsupported expression');
}

export interface CompiledExpression {
  readonly source: string;
  evaluate(scope: Record<string, unknown>): unknown;
  test(scope: Record<string, unknown>): boolean;
}

const cache = new Map<string, CompiledExpression>();

function parse(source: string): Node {
  if (source.length > MAX_LENGTH) throw new ExpressionError('Expression is too long');
  return new Parser(tokenize(source)).parse();
}

export function compileExpression(source: string): CompiledExpression {
  const hit = cache.get(source);
  if (hit) return hit;
  const ast = parse(source);
  const compiled: CompiledExpression = {
    source,
    evaluate: (scope) => evaluate(ast, scope),
    test: (scope) => truthy(evaluate(ast, scope)),
  };
  if (cache.size > 5000) cache.clear();
  cache.set(source, compiled);
  return compiled;
}

export function checkExpression(source: string): string | null {
  try {
    compileExpression(source);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export type ValueType = 'number' | 'text' | 'boolean' | 'date' | 'list' | 'object' | 'null' | 'unknown';

export interface ExpressionInfo {
  /** Every name the expression reads, such as `record.amount`, with its offset in the source. */
  variables: { path: string[]; position: number }[];
  /** What the expression gives back, as far as can be told without running it. */
  resultType: ValueType;
}

const RETURNS: Record<string, ValueType> = {
  len: 'number',
  isEmpty: 'boolean',
  contains: 'boolean',
  lower: 'text',
  upper: 'text',
  trim: 'text',
  round: 'number',
  abs: 'number',
  min: 'number',
  max: 'number',
  today: 'date',
  now: 'text',
  daysBetween: 'number',
  addDays: 'date',
  text: 'text',
  number: 'number',
  sum: 'number',
  avg: 'number',
  count: 'number',
  formatMoney: 'text',
  formatDate: 'text',
  inWords: 'text',
};

/** Parses without evaluating; throws ExpressionError like compileExpression. */
export function analyseExpression(source: string, typeOf: (path: string[]) => ValueType = () => 'unknown'): ExpressionInfo {
  const variables: ExpressionInfo['variables'] = [];
  const walk = (n: Node): ValueType => {
    switch (n.t) {
      case 'lit':
        return n.v === null ? 'null' : typeof n.v === 'number' ? 'number' : typeof n.v === 'string' ? 'text' : 'boolean';
      case 'var':
        variables.push({ path: n.path, position: n.pos });
        return typeOf(n.path);
      case 'un':
        walk(n.a);
        return n.op === 'not' ? 'boolean' : 'number';
      case 'cond': {
        walk(n.c);
        const a = walk(n.a);
        const b = walk(n.b);
        return a === b || b === 'null' ? a : a === 'null' ? b : 'unknown';
      }
      case 'call': {
        const args = n.args.map(walk);
        if (n.name === 'coalesce') return args.find((a) => a !== 'null' && a !== 'unknown') ?? 'unknown';
        return RETURNS[n.name] ?? 'unknown';
      }
      case 'bin': {
        const a = walk(n.a);
        const b = walk(n.b);
        if (['and', 'or', '==', '!=', '<', '<=', '>', '>='].includes(n.op)) return 'boolean';
        if (n.op !== '+') return 'number';
        if ([a, b].some((x) => x === 'text' || x === 'date')) return 'text';
        return a === 'number' && b === 'number' ? 'number' : 'unknown';
      }
    }
  };
  const resultType = walk(parse(source));
  return { variables, resultType };
}
