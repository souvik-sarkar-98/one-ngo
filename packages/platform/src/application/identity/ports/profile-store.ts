import type { PersonOption } from '../people-service.js';
import type { Tx } from '../../../domain/ports/transaction.js';

/** The people picker, inside a tenant transaction. */
export interface ProfileStore {
  /**
   * Members matching `pattern` (a lower-case LIKE pattern) on name or email when `q` is set, and whose email is exactly
   * `email` when it is set. Active members only, unless `includeInvited`, which adds those who have never signed in.
   */
  pickable(tx: Tx, query: { q: string; pattern: string; limit: number; email: string; includeInvited: boolean }): Promise<PersonOption[]>;
}
