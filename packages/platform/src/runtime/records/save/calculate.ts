import { richTextToPlain, sanitiseRichText } from '../rich-text.js';
import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { RecordTypeDef } from '../../definitions/types.js';
import type { SaveContext } from './context.js';
import { evalValue, scope } from './scope.js';

/** Cleans rich text (blank rich text is dropped), then computes calculated fields. */
export async function calculate(_tx: Tx, s: SaveContext): Promise<void> {
  const { type, data } = s;
  for (const f of type.fields) {
    if (f.type === 'richText' && typeof data[f.key] === 'string') {
      const clean = sanitiseRichText(data[f.key] as string);
      if (richTextToPlain(clean)) data[f.key] = clean;
      else delete data[f.key];
    }
  }
  s.data = calculatedData(s.ctx, type, data, s.status, s.previous);
}

export function calculatedData(
  ctx: TenantContext,
  type: RecordTypeDef,
  data: Record<string, unknown>,
  status: string | null,
  previous: Record<string, unknown> | null,
): Record<string, unknown> {
  const out = { ...data };
  for (const f of type.fields) {
    if (!f.calculated) continue;
    delete out[f.key];
    const value = evalValue(f.calculated, scope(ctx, out, status, previous), `field ${f.key}`);
    if (value !== null && value !== undefined && !(typeof value === 'number' && !Number.isFinite(value))) {
      out[f.key] = f.type === 'money' && typeof value === 'number' ? Math.round(value * 100) / 100 : value;
    }
  }
  return out;
}
