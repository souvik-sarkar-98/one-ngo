import type { Tx } from '../../../domain/ports/transaction.js';

/** The members of the open transaction's organisation, as person fields see them. */
export interface PersonDirectory {
  /** Those of `ids` (user ids) who are active members. */
  activeMembers(tx: Tx, ids: string[]): Promise<Set<string>>;
  /** Display names of members among `ids`, whatever their status. */
  names(tx: Tx, ids: string[]): Promise<Map<string, string>>;
  /** Display name and email of members among `ids`, whatever their status. `name` is the member's display name, otherwise the account name. */
  identities(tx: Tx, ids: string[]): Promise<Map<string, { name: string; email: string }>>;
  /** The membership status of user `userId`, if they are a member. */
  memberStatus(tx: Tx, userId: string): Promise<string | undefined>;
  /** The member with this user id, or else this email (ignoring case), and whether they are active. */
  find(tx: Tx, by: { userId: string } | { email: string }): Promise<{ userId: string; active: boolean } | undefined>;
}
