import { sanitiseEmailHtml } from '../../shared/records/email-html.js';
import { checkExpression, compileExpression } from '../expressions/expression.js';

const PLACEHOLDER = /\{\{\s*([\s\S]+?)\s*\}\}/g;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function placeholderText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Fills `{{ expression }}` placeholders. Output is plain text; nothing is interpreted as markup. */
export function renderTemplate(text: string, scope: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER, (_m, expr: string) => placeholderText(compileExpression(expr).evaluate(scope)));
}

/** Fills `{{ expression }}` placeholders for HTML. Each value is escaped so it cannot become markup. */
export function renderTemplateHtml(text: string, scope: Record<string, unknown>): string {
  return text.replace(PLACEHOLDER, (_m, expr: string) => placeholderText(compileExpression(expr).evaluate(scope)).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!));
}

/** Fills placeholders, then keeps only the HTML an email may carry. Blank when there is nothing left. */
export function renderEmailHtml(text: string, scope: Record<string, unknown>): string {
  return sanitiseEmailHtml(renderTemplateHtml(text, scope)).trim();
}

export function checkTemplate(text: string): string[] {
  const errors: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const err = checkExpression(m[1]!);
    if (err) errors.push(`'{{ ${m[1]} }}': ${err}`);
  }
  return errors;
}
