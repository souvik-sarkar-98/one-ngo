import { sanitiseDocumentHtml } from '../../shared/records/email-html.js';
import { checkExpression, compileExpression } from '../expressions/expression.js';

const TAG = /\{\{\s*([\s\S]+?)\s*\}\}/g;
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const EACH = /^#each\s+(\S+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const MAX_DEPTH = 8;

interface Piece {
  kind: 'text' | 'tag';
  value: string;
}

export class DocumentTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentTemplateError';
  }
}

function pieces(src: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  for (const m of src.matchAll(TAG)) {
    const at = m.index ?? 0;
    if (at > i) out.push({ kind: 'text', value: src.slice(i, at) });
    out.push({ kind: 'tag', value: m[1]!.trim() });
    i = at + m[0].length;
  }
  if (i < src.length) out.push({ kind: 'text', value: src.slice(i) });
  return out;
}

function join(items: Piece[]): string {
  return items.map((p) => (p.kind === 'text' ? p.value : `{{ ${p.value} }}`)).join('');
}

function escapeHtml(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

function truthy(value: unknown): boolean {
  return compileExpression('x').test({ x: value });
}

/** Index of the matching close tag, counting nested blocks of the same name. */
function closeAt(items: Piece[], from: number, name: 'each' | 'if'): number {
  let depth = 0;
  for (let i = from + 1; i < items.length; i++) {
    const tag = items[i]!.kind === 'tag' ? items[i]!.value : '';
    if (tag.startsWith(`#${name} `) || tag === `#${name}`) depth++;
    else if (tag === `/${name}` && depth-- === 0) return i;
  }
  throw new DocumentTemplateError(`{{#${name}}} has no {{/${name}}}`);
}

function elseAt(items: Piece[], from: number, end: number): number | undefined {
  let depth = 0;
  for (let i = from + 1; i < end; i++) {
    const tag = items[i]!.kind === 'tag' ? items[i]!.value : '';
    if (tag.startsWith('#if ') || tag === '#if') depth++;
    else if (tag === '/if') depth--;
    else if (tag === 'else' && depth === 0) return i;
  }
  return undefined;
}

function renderPieces(items: Piece[], scope: Record<string, unknown>, partial: (name: string) => string | undefined, depth: number): string {
  if (depth > MAX_DEPTH) throw new DocumentTemplateError('Template is nested too deeply.');
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const piece = items[i]!;
    if (piece.kind === 'text') {
      out.push(piece.value);
      continue;
    }
    const tag = piece.value;
    if (tag.startsWith('#each ') || tag === '#each') {
      const m = EACH.exec(tag);
      if (!m) throw new DocumentTemplateError("'{{#each}}' needs a path and a name, for example {{#each datasets.rows.rows as row}}.");
      const end = closeAt(items, i, 'each');
      const list = compileExpression(m[1]!).evaluate(scope);
      const body = items.slice(i + 1, end);
      for (const item of Array.isArray(list) ? list : []) {
        out.push(renderPieces(body, { ...scope, [m[2]!]: item }, partial, depth));
      }
      i = end;
      continue;
    }
    if (tag.startsWith('#if ') || tag === '#if') {
      const expr = tag.slice(3).trim();
      if (!expr) throw new DocumentTemplateError("'{{#if}}' needs an expression.");
      const end = closeAt(items, i, 'if');
      const mid = elseAt(items, i, end);
      const yes = truthy(compileExpression(expr).evaluate(scope));
      const body = yes ? items.slice(i + 1, mid ?? end) : mid === undefined ? [] : items.slice(mid + 1, end);
      if (body.length) out.push(renderPieces(body, scope, partial, depth));
      i = end;
      continue;
    }
    if (tag.startsWith('>')) {
      const name = tag.slice(1).trim();
      if (!/^[a-z][a-zA-Z0-9_-]{0,62}$/.test(name)) throw new DocumentTemplateError(`'{{> ${name}}}' is not a template name.`);
      const inner = partial(name);
      if (inner === undefined) throw new DocumentTemplateError(`Template '${name}' is not published.`);
      out.push(renderPieces(pieces(inner), scope, partial, depth + 1));
      continue;
    }
    if (tag === 'else' || tag.startsWith('#') || tag.startsWith('/')) throw new DocumentTemplateError(`Unexpected '{{ ${tag} }}'.`);
    out.push(escapeHtml(compileExpression(tag).evaluate(scope)));
  }
  return out.join('');
}

/** Fills a document template, escapes every value, then keeps only the HTML a printed page may carry. */
export function renderDocumentHtml(html: string, scope: Record<string, unknown>, partial: (name: string) => string | undefined = () => undefined): string {
  return sanitiseDocumentHtml(renderPieces(pieces(html), scope, partial, 0));
}

function walk(items: Piece[], errors: string[]): void {
  for (let i = 0; i < items.length; i++) {
    const piece = items[i]!;
    if (piece.kind !== 'tag') continue;
    const tag = piece.value;
    if (tag.startsWith('#each ') || tag === '#each') {
      const m = EACH.exec(tag);
      if (!m) errors.push("'{{#each}}' needs a path and a name");
      else {
        const err = checkExpression(m[1]!);
        if (err) errors.push(`'{{#each ${m[1]}}}': ${err}`);
      }
      let end: number;
      try {
        end = closeAt(items, i, 'each');
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        return;
      }
      walk(items.slice(i + 1, end), errors);
      i = end;
    } else if (tag.startsWith('#if ') || tag === '#if') {
      const expr = tag.slice(3).trim();
      const err = expr ? checkExpression(expr) : 'needs an expression';
      if (err) errors.push(`'{{#if}}': ${err}`);
      let end: number;
      try {
        end = closeAt(items, i, 'if');
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        return;
      }
      const mid = elseAt(items, i, end);
      walk(items.slice(i + 1, mid ?? end), errors);
      if (mid !== undefined) walk(items.slice(mid + 1, end), errors);
      i = end;
    } else if (tag.startsWith('>')) {
      const name = tag.slice(1).trim();
      if (!/^[a-z][a-zA-Z0-9_-]{0,62}$/.test(name)) errors.push(`'{{> ${name}}}' is not a template name`);
    } else if (tag === 'else' || tag.startsWith('#') || tag.startsWith('/')) {
      errors.push(`Unexpected '{{ ${tag} }}'`);
    } else {
      const err = checkExpression(tag);
      if (err) errors.push(`'{{ ${tag} }}': ${err}`);
    }
  }
}

/** Structural and expression problems in a document template. Empty when it can be rendered. */
export function checkDocumentTemplate(html: string): string[] {
  const errors: string[] = [];
  walk(pieces(html), errors);
  return errors;
}
