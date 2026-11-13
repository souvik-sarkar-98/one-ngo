import type { AuditInput } from '../../ports/audit-trail.js';
import type { Tx } from '../../ports/transaction.js';

export interface ApiKeyRow {
  id: string;
  name: string;
  role_key: string | null;
  feed_key: string | null;
  created_by: string;
  created_at: string | Date;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
}

/** The organisation's API keys, inside a tenant transaction. Only the hash of a secret is stored. */
export interface ApiKeyStore {
  /** Active keys first, then by name, newest first. */
  list(tx: Tx): Promise<ApiKeyRow[]>;
  /** The role's label and permissions; undefined when the organisation has no such role. */
  role(tx: Tx, role: string): Promise<{ key: string; label: string; permissions: string[] } | undefined>;
  /** The role and its permissions of the active key with this name. */
  activeRole(tx: Tx, name: string): Promise<{ role_key: string; permissions: string[] } | undefined>;
  /** Whether an active key already has this name, ignoring case. */
  activeNameTaken(tx: Tx, name: string): Promise<boolean>;
  insert(tx: Tx, key: { name: string; secretHash: string; role: string | null; feed: string | null; createdBy: string }): Promise<ApiKeyRow>;
  /** Revokes an active key; undefined when there is none with this id. */
  revoke(tx: Tx, id: string): Promise<{ name: string } | undefined>;
  audit(tx: Tx, entry: AuditInput): Promise<void>;
}
