/** NIST-style authentication assurance levels, ordered from weakest to strongest. */
export type AssuranceLevel = 'aal1' | 'aal2' | 'aal3';

export interface AuthenticationEvidence {
  method: string;
  assurance: AssuranceLevel;
  authTime: Date;
  amr: string[];
  acr?: string;
  providerIssuer?: string;
  providerSid?: string;
}

export interface TenantAuthPolicy {
  passwordEnabled: boolean;
  emailCodeEnabled: boolean;
  /** Device passkeys with user verification. They count as AAL2, never AAL3. */
  passkeyEnabled: boolean;
  minimumAssurance: AssuranceLevel;
}
