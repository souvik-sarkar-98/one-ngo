import type { AssuranceLevel, TenantAuthPolicy } from './ports/assurance.js';

const ASSURANCE_RANK: Readonly<Record<AssuranceLevel, number>> = {
  aal1: 1,
  aal2: 2,
  aal3: 3,
};

export function assuranceAtLeast(actual: AssuranceLevel, required: AssuranceLevel): boolean {
  return ASSURANCE_RANK[actual] >= ASSURANCE_RANK[required];
}

/** A local TOTP second factor raises AAL1 to AAL2, but can never manufacture AAL3. */
export function withTotp(actual: AssuranceLevel): AssuranceLevel {
  return actual === 'aal1' ? 'aal2' : actual;
}

/**
 * A platform passkey is a possession factor bound to the device plus a local
 * user verification (biometric or device PIN). Assertions with verification are
 * AAL2; the authenticator never supplies AAL3 for an NGO.
 */
export const PASSKEY_ASSURANCE: AssuranceLevel = 'aal2';

export const DEFAULT_AUTH_POLICY: Readonly<TenantAuthPolicy> = {
  passwordEnabled: true,
  emailCodeEnabled: true,
  passkeyEnabled: false,
  minimumAssurance: 'aal1',
};
