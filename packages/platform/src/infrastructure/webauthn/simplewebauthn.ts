import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { WebAuthnCeremonies } from '../../domain/identity/ports/webauthn-ceremonies.js';

/** Signature algorithms accepted for new passkeys: ES256 and RS256. */
const ALGORITHMS = [-7, -257];

/**
 * WebAuthn ceremonies via @simplewebauthn/server. Attestation is not requested:
 * an NGO needs proof of a possession factor, not of a device model. User
 * verification is required so every passkey sign-in is AAL2.
 */
export function simpleWebAuthnCeremonies(): WebAuthnCeremonies {
  return {
    async registrationOptions({ relyingParty, userId, userName, displayName, excludeCredentials }) {
      const options = await generateRegistrationOptions({
        rpName: relyingParty.name,
        rpID: relyingParty.id,
        userID: new TextEncoder().encode(userId),
        userName,
        userDisplayName: displayName,
        attestationType: 'none',
        excludeCredentials: excludeCredentials.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        supportedAlgorithmIDs: ALGORITHMS as never,
      });
      return { challenge: options.challenge, options };
    },

    async verifyRegistration({ relyingParty, response, expectedChallenge }) {
      const result = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: relyingParty.origins,
        expectedRPID: relyingParty.id,
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error('The passkey could not be verified.');
      const info = result.registrationInfo;
      return {
        credentialId: info.credential.id,
        publicKey: info.credential.publicKey,
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        userVerified: info.userVerified,
      };
    },

    async assertionOptions({ relyingParty }) {
      const options = await generateAuthenticationOptions({
        rpID: relyingParty.id,
        userVerification: 'required',
        allowCredentials: [],
      });
      return { challenge: options.challenge, options };
    },

    async verifyAssertion({ relyingParty, response, expectedChallenge, credential }) {
      const result = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge,
        expectedOrigin: relyingParty.origins,
        expectedRPID: relyingParty.id,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports as never,
        },
      });
      if (!result.verified) throw new Error('The passkey could not be verified.');
      return {
        credentialId: result.authenticationInfo.credentialID,
        newCounter: result.authenticationInfo.newCounter,
        userVerified: result.authenticationInfo.userVerified,
      };
    },
  };
}
