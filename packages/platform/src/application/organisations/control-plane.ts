import type { OidcProviderInput } from '../identity/oidc.js';
import type { AssuranceLevel, TenantAuthPolicy } from '../../domain/identity/ports/assurance.js';
import type { OrganisationStatus } from './lifecycle-service.js';
import type { OrganisationLifecycleService } from './lifecycle-service.js';
import type { OnboardingOutcome, OrganisationOnboardingService } from './onboarding-service.js';
import { operatorAuditActor, steppedOperatorActor, type OperatorPrincipal } from './operator-principal.js';
import type { OrganisationSignIn, OrganisationSignInService, ProviderCheck } from './sign-in-service.js';

/** Internal services exposed only through the authenticated operator facade. */
export interface OrganisationOperations {
  onboarding: OrganisationOnboardingService;
  lifecycle: OrganisationLifecycleService;
  signIn: OrganisationSignInService;
}

/** An organisation's sign-in, as operators see and change it. Every change needs a one-use step-up and a reason. */
export interface OperatorSignInControl {
  get(principal: OperatorPrincipal, code: string): Promise<OrganisationSignIn>;
  savePolicy(
    principal: OperatorPrincipal,
    code: string,
    policy: Omit<TenantAuthPolicy, 'passkeyEnabled'> & { passkeyEnabled?: boolean },
    reason: string,
    stepUpId: string,
  ): Promise<OrganisationSignIn>;
  saveProvider(principal: OperatorPrincipal, code: string, provider: OidcProviderInput, reason: string, stepUpId: string): Promise<OrganisationSignIn>;
  removeProvider(principal: OperatorPrincipal, code: string, providerId: string, reason: string, stepUpId: string): Promise<OrganisationSignIn>;
  setProviderPolicy(
    principal: OperatorPrincipal,
    code: string,
    providerId: string,
    policy: { enabled: boolean; assurance: AssuranceLevel; allowedDomains?: string[] },
    reason: string,
    stepUpId: string,
  ): Promise<OrganisationSignIn>;
  testProvider(principal: OperatorPrincipal, code: string, providerId: string): Promise<ProviderCheck>;
}

export interface OperatorControlPlane {
  onboard(principal: OperatorPrincipal, input: unknown, options?: { validateOnly?: boolean }): Promise<OnboardingOutcome>;
  status(principal: OperatorPrincipal, ref: { code?: string; requestId?: string }): Promise<OrganisationStatus>;
  retry(principal: OperatorPrincipal, requestId: string): Promise<OnboardingOutcome>;
  suspend(principal: OperatorPrincipal, code: string, reason: string, stepUpId?: string): Promise<OrganisationStatus>;
  reactivate(principal: OperatorPrincipal, code: string, reason?: string, stepUpId?: string): Promise<OrganisationStatus>;
  close(principal: OperatorPrincipal, code: string, reason: string, stepUpId?: string): Promise<OrganisationStatus>;
  signIn: OperatorSignInControl;
}

/**
 * The only public facade over operator onboarding and lifecycle capabilities.
 * Each call is refused unless the principal is granted its action; suspend,
 * reactivate, close and sign-in changes also need a step-up id.
 */
export function operatorControlPlane(operations: OrganisationOperations): OperatorControlPlane {
  const signIn = operations.signIn;
  return {
    onboard: async (principal, input, options) => operations.onboarding.onboard(operatorAuditActor(principal, 'onboard'), input, options),
    status: async (principal, ref) => {
      operatorAuditActor(principal, 'status');
      return operations.lifecycle.status(ref);
    },
    retry: async (principal, requestId) => operations.onboarding.retry(operatorAuditActor(principal, 'retry'), requestId),
    suspend: async (principal, code, reason, stepUpId) => operations.lifecycle.suspend(steppedOperatorActor(principal, 'suspend', stepUpId), code, reason),
    reactivate: async (principal, code, reason, stepUpId) => operations.lifecycle.reactivate(steppedOperatorActor(principal, 'reactivate', stepUpId), code, reason),
    close: async (principal, code, reason, stepUpId) => operations.lifecycle.close(steppedOperatorActor(principal, 'close', stepUpId), code, reason),
    signIn: {
      get: async (principal, code) => {
        operatorAuditActor(principal, 'sign_in');
        return signIn.view(code);
      },
      savePolicy: async (principal, code, policy, reason, stepUpId) => signIn.savePolicy(steppedOperatorActor(principal, 'sign_in', stepUpId), code, policy, reason),
      saveProvider: async (principal, code, provider, reason, stepUpId) => signIn.saveProvider(steppedOperatorActor(principal, 'sign_in', stepUpId), code, provider, reason),
      removeProvider: async (principal, code, providerId, reason, stepUpId) => signIn.removeProvider(steppedOperatorActor(principal, 'sign_in', stepUpId), code, providerId, reason),
      setProviderPolicy: async (principal, code, providerId, policy, reason, stepUpId) =>
        signIn.setProviderPolicy(steppedOperatorActor(principal, 'sign_in', stepUpId), code, providerId, policy, reason),
      testProvider: async (principal, code, providerId) => {
        operatorAuditActor(principal, 'sign_in');
        return signIn.testProvider(code, providerId);
      },
    },
  };
}
