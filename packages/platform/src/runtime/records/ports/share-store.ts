import type { AuditInput } from './audit-input.js';
import type { Tx } from '../../../domain/ports/transaction.js';

export type PrincipalKind = 'user' | 'role';
export type ShareAccess = 'read' | 'edit';

export interface ShareRow {
  id: string;
  principal_kind: PrincipalKind;
  principal: string;
  /** The person's name or the role's label, else the principal. */
  name: string;
  access: ShareAccess;
  created_by: string;
  created_at: string | Date;
  expires_at: string | Date | null;
}

export interface NewShare {
  recordId: string;
  principalKind: PrincipalKind;
  principal: string;
  access: ShareAccess;
  createdBy: string;
  /** ISO date-time, or null for no end. */
  expiresAt: string | null;
}

/** Shares of records with people and roles, in the open transaction's organisation. */
export interface ShareStore {
  /** The record's shares, oldest first. */
  list(tx: Tx, recordId: string): Promise<ShareRow[]>;
  isActiveMember(tx: Tx, userId: string): Promise<boolean>;
  isRole(tx: Tx, key: string): Promise<boolean>;
  /** The record's share with the principal, locked until the transaction ends, and whether it has not expired. */
  lockShare(tx: Tx, recordId: string, principalKind: PrincipalKind, principal: string): Promise<{ id: string; live: boolean } | undefined>;
  /** Changes a share's access and end; its id. */
  changeShare(tx: Tx, id: string, access: ShareAccess, expiresAt: string | null): Promise<string | undefined>;
  /** The new share's id. */
  addShare(tx: Tx, share: NewShare): Promise<string | undefined>;
  /** Deletes the record's share `shareId`; what it granted, or undefined when there was none. */
  removeShare(tx: Tx, recordId: string, shareId: string): Promise<{ principal_kind: string; principal: string; access: string } | undefined>;
  /**
   * Active members other than `exceptUserId`, and roles, whose name, email or key match `like` (all when `q` is empty),
   * at most `max` of each, each with the permissions their roles grant them.
   */
  candidates(
    tx: Tx,
    query: { q: string; like: string; exceptUserId: string; max: number },
  ): Promise<{ people: { id: string; name: string; email: string; permissions: string[] }[]; roles: { key: string; label: string; permissions: string[] }[] }>;
  userName(tx: Tx, userId: string): Promise<string | undefined>;
  audit(tx: Tx, input: AuditInput): Promise<void>;
}
