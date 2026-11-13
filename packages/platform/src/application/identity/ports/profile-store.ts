import type { PersonOption } from '../people-service.js';
import type { Tx } from '../../../domain/ports/transaction.js';

/** The people picker, inside a tenant transaction. */
export interface ProfileStore {
  /** Active members who have signed in, matching `pattern` (a lower-case LIKE pattern) on name or email when `q` is set. */
  pickable(tx: Tx, query: { q: string; pattern: string; limit: number }): Promise<PersonOption[]>;
}
