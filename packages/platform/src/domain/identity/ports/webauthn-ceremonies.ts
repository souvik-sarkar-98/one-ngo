/**
 * The WebAuthn ceremonies the passkey service needs. The adapter that
 * implements them (infrastructure/webauthn) checks the browser's response
 * against the challenge, origin and relying party; the service decides what a
 * verified response means for the person and their sign-in.
 */
export interface PasskeyRelyingParty {
  /** Shown by the authenticator, e.g. "OneNGO". */
  name: string;
  /** The registrable host the passkey belongs to, e.g. ngo.example.org or localhost. */
  id: string;
  /** Page origins allowed to run a ceremony, e.g. https://ngo.example.org. */
  origins: string[];
}

export interface PasskeyRegistrationOptions {
  challenge: string;
  /** Browser-ready options: the challenge and ids are base64url strings. */
  options: unknown;
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  userVerified: boolean;
}

export interface VerifiedAssertion {
  credentialId: string;
  /** The counter the authenticator reports after this use. */
  newCounter: number;
  userVerified: boolean;
}

export interface WebAuthnCeremonies {
  registrationOptions(input: {
    relyingParty: PasskeyRelyingParty;
    userId: string;
    userName: string;
    displayName: string;
    excludeCredentials: { credentialId: string; transports: string[] }[];
  }): Promise<PasskeyRegistrationOptions>;

  verifyRegistration(input: { relyingParty: PasskeyRelyingParty; response: unknown; expectedChallenge: string }): Promise<VerifiedRegistration>;

  /** Usernameless: the authenticator offers the passkeys it holds for the relying party. */
  assertionOptions(input: { relyingParty: PasskeyRelyingParty }): Promise<PasskeyRegistrationOptions>;

  verifyAssertion(input: {
    relyingParty: PasskeyRelyingParty;
    response: unknown;
    expectedChallenge: string;
    credential: { credentialId: string; publicKey: Uint8Array; counter: number; transports: string[] };
  }): Promise<VerifiedAssertion>;
}
