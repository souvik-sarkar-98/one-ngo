import type { Tx } from '../../../domain/ports/transaction.js';

/** The languages members of the organisation in the open transaction have chosen. */
export interface LocaleStore {
  /** The member's chosen language, else the organisation's default; null when neither is set. */
  locale(tx: Tx, userId: string): Promise<string | null>;
  /** Saves the member's language; false when they are not a member. */
  setLocale(tx: Tx, userId: string, locale: string): Promise<boolean>;
}
