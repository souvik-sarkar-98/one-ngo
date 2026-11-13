import type { AuditInput } from '../../ports/audit-trail.js';
import type { Tx } from '../../ports/transaction.js';

/** One of the organisation's own providers, as stored. The secret is encrypted. */
export interface StoredOidcProvider {
  key: string;
  config: unknown;
  secret_enc: string | null;
  updated_at: Date;
}

/** The organisation's own sign-in providers, inside a tenant transaction. The client secret is stored encrypted. */
export interface OidcStore {
  /** Creates or replaces the provider and switches it on. */
  saveProvider(tx: Tx, provider: { key: string; config: string; secretEnc: string; updatedBy: string }): Promise<void>;
  /** Enabled providers. */
  providers(tx: Tx): Promise<{ key: string; config: unknown; secret_enc: string | null }[]>;
  /** Enabled providers with when each last changed. */
  providerDetails(tx: Tx): Promise<StoredOidcProvider[]>;
  /** Switches the provider off and forgets its secret; returns whether one was on. Saving it again switches it back on. */
  removeProvider(tx: Tx, key: string, updatedBy: string): Promise<boolean>;
  audit(tx: Tx, entry: AuditInput): Promise<void>;
}
