/** Passkey rules that do not depend on storage or the WebAuthn library. */

/** Registered passkeys one person may keep. */
export const MAX_PASSKEYS_PER_PERSON = 10;

/** Ceremony challenges are one-time and expire after this many seconds. */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 300;

/** Sign-in with a passkey is limited per network address in this window. */
export const PASSKEY_LIMIT = { attempts: 30, windowSeconds: 15 * 60 } as const;

const NAME_MAX = 60;
export const DEFAULT_PASSKEY_NAME = 'Passkey';

/** A display name typed by the person: trimmed, bounded, never empty. */
export function passkeyName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return name ? name.slice(0, NAME_MAX) : DEFAULT_PASSKEY_NAME;
}

/**
 * WebAuthn signature counters must rise with each use. A counter that does not
 * rise suggests a cloned authenticator. Authenticators that never count (both
 * values zero) are accepted, since refusing them would lock out valid devices.
 */
export function counterAccepted(stored: number, reported: number): boolean {
  if (stored === 0 && reported === 0) return true;
  return reported > stored;
}
