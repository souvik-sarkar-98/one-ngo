import type { Tx } from '../../ports/transaction.js';

export interface PinRow {
  id: string;
  label: string;
  list_view: string;
  address: string;
  position: number;
}

/** A person's own pinned lists, inside a tenant transaction. Actor and pin ids are compared as text. */
export interface PinStore {
  list(tx: Tx, actorId: string): Promise<PinRow[]>;
  count(tx: Tx, actorId: string): Promise<number>;
  /** Adds the pin last; undefined when the actor is not a member of the organisation. */
  add(tx: Tx, actorId: string, pin: { label: string; listView: string; address: string }): Promise<PinRow | undefined>;
  rename(tx: Tx, actorId: string, id: string, label: string): Promise<PinRow | undefined>;
  move(tx: Tx, actorId: string, id: string, position: number): Promise<void>;
  /** False when the actor has no such pin. */
  remove(tx: Tx, actorId: string, id: string): Promise<boolean>;
}
