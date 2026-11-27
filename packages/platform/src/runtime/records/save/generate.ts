import type { Tx } from '../../../domain/ports/transaction.js';
import { counterDigits, initialOf, parseGenerated, yymmOf, type GeneratedPart } from '../../expressions/generated-pattern.js';
import type { FieldDef } from '../../definitions/types.js';
import type { RecordStore } from '../ports/record-store.js';
import type { SaveContext } from './context.js';

const filled = (v: unknown) => v !== undefined && v !== null && v !== '';

/**
 * Fills generated fields that are still empty, before calculated values, scripts and checks run.
 * This covers creates and any later save of a record that has no value yet, such as members saved
 * before the field existed. Preview saves change nothing, so they take no counter value.
 */
export async function generate(tx: Tx, s: SaveContext): Promise<void> {
  if (s.dryRun) return;
  for (const f of s.type.fields) {
    if (!f.generated || filled(s.data[f.key])) continue;
    const value = await nextGenerated(s.services.store, tx, s.type.key, f, s.data);
    if (value !== null) s.data[f.key] = value;
  }
}

/**
 * The next value of a generated field: the prefix built from the record's values, then the next
 * counter value under that prefix. Null when a value the pattern reads is missing or not a date;
 * the field's own required and type checks then report it.
 */
export async function nextGenerated(store: RecordStore, tx: Tx, typeKey: string, f: FieldDef, data: Record<string, unknown>): Promise<string | null> {
  const parts = parseGenerated(f.generated?.pattern ?? '');
  if (typeof parts === 'string') return null;
  let prefix = '';
  for (const p of parts) {
    if (p.kind === 'text') prefix += p.text;
    else if (p.kind === 'initial') prefix += initialOf(data[p.field]);
    else if (p.kind === 'yymm') {
      const yymm = yymmOf(data[p.field]);
      if (yymm === null) return null;
      prefix += yymm;
    }
  }
  const seq = parts.at(-1) as Extract<GeneratedPart, { kind: 'seq' }>;
  // Counters are per type, field and prefix. The row lock lasts until the save's transaction ends,
  // so two saves with the same prefix take different values, and a rolled-back save takes none.
  const n = await store.nextSequenceValue(tx, `generated:${typeKey}:${f.key}:${prefix}`, 'all');
  return prefix + counterDigits(n, seq.width);
}
