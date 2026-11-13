import type { AuditInput } from '../../ports/audit-trail.js';
import type { Tx } from '../../ports/transaction.js';

export interface StoredRole {
  key: string;
  label: string;
  permissions: string[];
  requireTwoStep: boolean;
  customised: boolean;
  members: number;
}

export interface RoleFields {
  label: string;
  permissions: string[];
  requireTwoStep: boolean;
}

/** The organisation's roles and who holds them, inside a tenant transaction. */
export interface RoleStore {
  /** Roles with member counts, by label; only `key` when given. */
  roles(tx: Tx, key?: string): Promise<StoredRole[]>;
  /** Every role's permissions, by label. */
  grants(tx: Tx): Promise<{ key: string; label: string; permissions: string[] }[]>;
  label(tx: Tx, key: string): Promise<{ key: string; label: string } | undefined>;
  exists(tx: Tx, key: string): Promise<boolean>;
  /** Which of `keys` are roles. */
  existing(tx: Tx, keys: string[]): Promise<string[]>;
  /** Creates or replaces the role without marking it customised. */
  save(tx: Tx, key: string, role: RoleFields): Promise<void>;
  create(tx: Tx, key: string, role: RoleFields): Promise<void>;
  update(tx: Tx, key: string, role: RoleFields): Promise<void>;
  remove(tx: Tx, key: string): Promise<void>;
  apiKeysUsing(tx: Tx, key: string): Promise<number>;
  /** The member's role keys, sorted. */
  assigned(tx: Tx, userId: string): Promise<string[]>;
  /** Gives the role; one already held is kept. */
  assign(tx: Tx, userId: string, roleKey: string, assignedBy: string): Promise<void>;
  /** Gives a role the member does not hold yet. */
  add(tx: Tx, userId: string, roleKey: string, assignedBy: string): Promise<void>;
  unassign(tx: Tx, userId: string, roleKey: string): Promise<void>;
  unassignAllExcept(tx: Tx, userId: string, keep: string[]): Promise<void>;
  /** Each role held by an active person with an active account, with its permissions. */
  activeHolders(tx: Tx): Promise<{ userId: string; permissions: string[] }[]>;
  audit(tx: Tx, entry: AuditInput): Promise<void>;
}
