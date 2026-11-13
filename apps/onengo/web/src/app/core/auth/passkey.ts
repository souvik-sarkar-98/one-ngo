/**
 * Passkeys in the browser: the WebAuthn calls and the base64url conversions they
 * need. The server speaks WebAuthn's JSON form (base64url strings); the browser
 * API wants binary buffers. The fingerprint, face or PIN check happens inside the
 * browser's own prompt; this code never receives biometric data.
 */

/** A WebAuthn credential as JSON, ready to post to the server. */
export interface PasskeyResponse {
  id: string;
  rawId: string;
  type: string;
  response: Record<string, unknown>;
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment?: string;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Base64url (no padding) to bytes. */
export function fromBase64url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Bytes to base64url (no padding). */
export function toBase64url(buffer: ArrayBuffer): string {
  return toBase64(new Uint8Array(buffer)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Whether this browser can save and use a passkey on this device. Never throws. */
export async function passkeysSupported(): Promise<boolean> {
  if (typeof window === 'undefined' || !('PublicKeyCredential' in window) || !navigator.credentials) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Options from the server, in JSON form, turned into the form the browser expects. */
interface JsonOptions {
  challenge: string;
  user?: { id: string } & Record<string, unknown>;
  allowCredentials?: { id: string }[];
  excludeCredentials?: { id: string }[];
  [key: string]: unknown;
}

const withIds = (list: { id: string }[] | undefined) => (list ?? []).map((c) => ({ ...c, id: fromBase64url(c.id) }));

/** Serialises a credential to WebAuthn's JSON form. */
function serialise(credential: PublicKeyCredential): PasskeyResponse {
  const response = credential.response as AuthenticatorAttestationResponse | AuthenticatorAssertionResponse;
  const out: Record<string, unknown> = {};
  if ('attestationObject' in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    out['clientDataJSON'] = toBase64url(attestation.clientDataJSON);
    out['attestationObject'] = toBase64url(attestation.attestationObject);
    out['transports'] = attestation.getTransports?.() ?? [];
  } else {
    const assertion = response as AuthenticatorAssertionResponse;
    out['clientDataJSON'] = toBase64url(assertion.clientDataJSON);
    out['authenticatorData'] = toBase64url(assertion.authenticatorData);
    out['signature'] = toBase64url(assertion.signature);
    out['userHandle'] = assertion.userHandle ? toBase64url(assertion.userHandle) : null;
  }
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    response: out,
    clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
  };
}

/** Asks the browser for a passkey saved for this site; resolves with the response to post. */
export async function getPasskey(options: unknown): Promise<PasskeyResponse> {
  const json = options as JsonOptions;
  const credential = (await navigator.credentials.get({
    publicKey: { ...json, challenge: fromBase64url(json.challenge), allowCredentials: withIds(json.allowCredentials) } as PublicKeyCredentialRequestOptions,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was chosen.');
  return serialise(credential);
}

/** Asks the browser to save a new passkey on this device; resolves with the response to post. */
export async function createPasskey(options: unknown): Promise<PasskeyResponse> {
  const json = options as JsonOptions;
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...json,
      challenge: fromBase64url(json.challenge),
      user: { ...json.user, id: fromBase64url(String(json.user?.id ?? '')) },
      excludeCredentials: withIds(json.excludeCredentials),
    } as unknown as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was saved.');
  return serialise(credential);
}
