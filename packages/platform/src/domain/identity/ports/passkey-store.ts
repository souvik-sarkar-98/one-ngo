export type PasskeyPurpose = 'register' | 'assert';

/** A stored credential as sign-in and management need it. The public key is COSE-encoded; no biometric data is ever stored. */
export interface PasskeyCredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string[];
  device_type: string;
  backed_up: boolean;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export interface PasskeyChallengeRow {
  id: string;
  tenant_id: string;
  purpose: PasskeyPurpose;
  user_id: string | null;
  challenge: string;
}

/**
 * Passkey credentials belong to a person, not an organisation: one passkey
 * signs in to every organisation the person belongs to. Organisations decide
 * whether passkeys are accepted at all (the auth policy).
 */
export interface PasskeyStore {
  /** Stores a one-time challenge; it cannot be used after `ttlSeconds`. */
  addChallenge(input: {
    tenantId: string;
    purpose: PasskeyPurpose;
    userId: string | null;
    challenge: string;
    ttlSeconds: number;
  }): Promise<string>;
  /**
   * Consumes a live, unused challenge of this purpose, atomically. Returns undefined
   * when it is unknown, expired, used, or for another organisation or person.
   */
  useChallenge(input: { id: string; purpose: PasskeyPurpose; tenantId: string; userId?: string }): Promise<PasskeyChallengeRow | undefined>;
  /** Live credentials of the person; ordered oldest first. */
  listForUser(userId: string): Promise<PasskeyCredentialRow[]>;
  /** A live credential by its WebAuthn id, with its owner. */
  byCredentialId(credentialId: string): Promise<PasskeyCredentialRow | undefined>;
  add(input: {
    userId: string;
    credentialId: string;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
    deviceType: string;
    backedUp: boolean;
    name: string;
  }): Promise<string>;
  /** Moves the counter from `previous` to `next` only if nothing else moved it; false when another sign-in won the race. */
  advanceCounter(id: string, previous: number, next: number): Promise<boolean>;
  touch(id: string): Promise<void>;
  rename(userId: string, id: string, name: string): Promise<boolean>;
  revoke(userId: string, id: string): Promise<boolean>;
  /** Revokes every passkey of the person. */
  revokeAll(userId: string): Promise<void>;
  countLive(userId: string): Promise<number>;
}
