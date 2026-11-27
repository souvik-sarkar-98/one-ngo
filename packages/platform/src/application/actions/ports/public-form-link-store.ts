import type { Tx } from '../../../domain/ports/transaction.js';

export interface StoredPublicLink {
  tokenEnc: string;
  revoked: boolean;
}

export interface CatalogueHit {
  id: string;
  number: string | null;
  status: string | null;
  data: Record<string, unknown>;
}

/**
 * Secret links for a record a visitor submitted, and the catalogue a public form searches. Tenant rows are
 * read and written inside the tenant's transaction; the token lookup matches only the hash of a live token.
 */
export interface PublicFormLinkStore {
  findLive(tokenHash: string): Promise<{ tenantId: string; recordId: string } | null>;
  link(tx: Tx, recordId: string): Promise<StoredPublicLink | undefined>;
  saveLink(tx: Tx, link: { recordId: string; tokenHash: string; tokenEnc: string; actorId: string }): Promise<void>;
  /** Whether a live link was revoked. */
  revokeLink(tx: Tx, recordId: string, actorId: string): Promise<boolean>;
  /** One page of catalogue hits. `limit` includes one extra row so the caller can tell that more exist. */
  search(tx: Tx, spec: { typeKey: string; statusIn: string[]; searchFields: string[]; q: string; limit: number }): Promise<CatalogueHit[]>;
}
