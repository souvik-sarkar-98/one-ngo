import type { AuditInput } from '../../ports/audit-trail.js';
import type { Actor } from '../../ports/tenant-context.js';
import type { Tx } from '../../ports/transaction.js';

/** The organisation's memberships, inside a tenant transaction. */
export interface MemberStore {
  /**
   * Adds the person to the organisation under `displayName`, the name this
   * organisation knows them by, or makes their membership active again (keeping its name).
   */
  join(tx: Tx, userId: string, displayName: string): Promise<void>;
  /**
   * Adds the person for a data migration. Unlike `join` it never reactivates: a new membership gets
   * `status`, an existing one keeps its own. With `update` (default true) an existing membership's
   * name and language follow the file; without it the existing membership is left as it is.
   * `locale` null leaves the language unset (new) or unchanged (existing).
   */
  importJoin(
    tx: Tx,
    userId: string,
    member: { displayName: string; status: 'active' | 'suspended'; locale: string | null; update?: boolean },
  ): Promise<{ created: boolean; changed: boolean; status: string }>;
  isMember(tx: Tx, userId: string): Promise<boolean>;
  status(tx: Tx, userId: string): Promise<string | undefined>;
  setStatus(tx: Tx, userId: string, status: 'active' | 'suspended'): Promise<void>;
  /** The organisation's access version, while it is active. */
  accessVersion(tx: Tx): Promise<number | undefined>;
  /** The active member's roles and permissions; null when they are not an active member. */
  actor(tx: Tx, userId: string): Promise<Actor | null>;
  organisation(tx: Tx): Promise<{ id: string; key: string; name: string } | undefined>;
  audit(tx: Tx, entry: AuditInput): Promise<void>;
}

/** A fixed-window limit shared by every instance, for actions that send messages. */
export interface SharedLimits {
  /** Returns true if the call is allowed. */
  hit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}
