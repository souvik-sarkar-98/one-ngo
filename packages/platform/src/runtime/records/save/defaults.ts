import type { Tx } from '../../../domain/ports/transaction.js';
import type { SaveContext } from './context.js';
import { evalValue, scope } from './scope.js';

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Fills fields with a `defaultFrom` suggestion. The suggestion is written when the field is blank, or when it
 * still holds the suggestion for the record as it was before this save and the fields it reads have changed.
 * A value the person typed is kept. Runs after the follow stage, so followed fields can feed a suggestion.
 */
export async function defaults(_tx: Tx, s: SaveContext): Promise<void> {
  // A new record starts a boolean field at its defaultValue unless the save gave one.
  if (!s.previous) {
    for (const f of s.type.fields) {
      if (f.type === 'boolean' && f.defaultValue !== undefined && blank(s.data[f.key])) s.data[f.key] = f.defaultValue;
    }
  }
  for (const f of s.type.fields) {
    if (!f.defaultFrom) continue;
    const where = `field ${f.key}`;
    const now = suggestion(evalValue(f.defaultFrom, scope(s.ctx, s.data, s.status, s.previous), where));
    const before = s.previous ? suggestion(evalValue(f.defaultFrom, scope(s.ctx, s.previous, s.previousStatus, null), where)) : null;
    if (now === before) continue;
    const current = s.data[f.key];
    if (!blank(current) && !(before !== null && current === before)) continue;
    if (now) s.data[f.key] = now;
    else delete s.data[f.key];
  }
}

function suggestion(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
