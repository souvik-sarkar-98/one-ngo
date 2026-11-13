import type { StoredData } from '../sensitive.js';
import type { SaveContext } from './context.js';

/**
 * The data as the write stores it: sensitive values encrypted under the
 * current key, with keyed hashes of the unique ones. Runs inside the write,
 * after the record's own rollups are set; `s.data` keeps the plain values for
 * the effects, audit and response that follow.
 */
export function encrypt(s: SaveContext): StoredData {
  return s.services.sensitive.seal(s.type, s.data);
}
