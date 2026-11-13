import { normaliseData } from '../validator.js';
import type { Tx } from '../../../domain/ports/transaction.js';
import type { SaveContext } from './context.js';

/** The stored data with the patch laid over it. */
export async function merge(_tx: Tx, s: SaveContext): Promise<void> {
  s.data = normaliseData({ ...(s.previous ?? {}), ...s.patch });
}
