import { PlatformError } from '@onengo/kernel/errors';
import type { AccountRow } from '../../../domain/identity/ports/identity-directory.js';
import { assuranceAtLeast } from '../../../domain/identity/assurance.js';
import type { AuthenticationEvidence, TenantAuthPolicy } from '../../../domain/identity/ports/assurance.js';

export interface ResolvedSignIn {
  tenantId: string;
  account: AccountRow;
  policy: TenantAuthPolicy;
}

/**
 * The method-independent half of sign-in. Credential adapters first produce
 * verified evidence; this pipeline then resolves the account and NGO policy,
 * enforces method/assurance policy, and delegates session issuance.
 */
export class SignInPipeline<T> {
  constructor(
    private readonly resolve: (tenantId: string, userId: string) => Promise<ResolvedSignIn>,
    private readonly issue: (resolved: ResolvedSignIn, evidence: AuthenticationEvidence) => Promise<T>,
  ) {}

  async complete(input: { tenantId: string; userId: string; evidence: AuthenticationEvidence }): Promise<T> {
    const resolved = await this.resolve(input.tenantId, input.userId);
    this.enforce(resolved.policy, input.evidence);
    return this.issue(resolved, input.evidence);
  }

  enforce(policy: TenantAuthPolicy, evidence: AuthenticationEvidence): void {
    if (evidence.method === 'password' && !policy.passwordEnabled) {
      throw new PlatformError('forbidden', 'Password sign-in is not available for this organisation.');
    }
    if (evidence.method === 'email_code' && !policy.emailCodeEnabled) {
      throw new PlatformError('forbidden', 'Email-code sign-in is not available for this organisation.');
    }
    if (evidence.method === 'passkey' && !policy.passkeyEnabled) {
      throw new PlatformError('forbidden', 'Passkey sign-in is not available for this organisation.');
    }
    if (!assuranceAtLeast(evidence.assurance, policy.minimumAssurance)) {
      throw new PlatformError('forbidden', 'This sign-in method does not meet the organisation’s assurance policy.');
    }
  }
}
