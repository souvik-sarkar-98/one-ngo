export const OPERATOR_ACTIONS = ['onboard', 'status', 'retry', 'suspend', 'reactivate', 'close', 'sign_in', 'operators', 'audit'] as const;
export type OperatorActionContract = (typeof OPERATOR_ACTIONS)[number];
export const OPERATOR_STEP_UP_ACTIONS = ['suspend', 'reactivate', 'close', 'sign_in', 'operators'] as const;
export type OperatorStepUpActionContract = (typeof OPERATOR_STEP_UP_ACTIONS)[number];

export interface OperatorSessionContract {
  authenticated: boolean;
  display?: string;
  /** The signed-in operator, so the console can keep that person from locking themselves out. */
  operatorId?: string;
  actions: OperatorActionContract[];
  csrfToken?: string;
}

export interface OperatorOnboardRequest {
  input: unknown;
  validateOnly: boolean;
}

export interface OperatorLifecycleRequest {
  reason?: string;
  stepUpId: string;
}

export interface OperatorStepUpRequest {
  action: OperatorStepUpActionContract;
  target: string;
  returnPath: string;
}

export interface OperatorStatusContract {
  organisation: {
    id: string;
    code: string;
    displayName: string;
    legalName: string | null;
    status: string;
    region: string | null;
    createdAt: string;
    statusChangedAt: string | null;
  } | null;
  onboarding: {
    requestId: string;
    state: string;
    step: string;
    invitation: string;
    failure: { code: string; message: string } | null;
    requestedBy: string;
    createdAt: string;
    completedAt: string | null;
  } | null;
  history: { at: string; operator: string; action: string; detail: unknown }[];
}

export interface OperatorOnboardResult {
  requestId: string;
  code: string;
  organisationId: string | null;
  status: string;
  step: string;
  invitation: string;
  failure: { code: string; message: string } | null;
}

export interface OperatorOrganisationSummary {
  code: string;
  displayName: string;
  legalName: string | null;
  status: string;
  region: string | null;
  createdAt: string;
}

export interface OperatorOrganisationListContract {
  organisations: OperatorOrganisationSummary[];
}

export interface OperatorIdentityContract {
  issuer: string;
  subject: string;
}

export interface OperatorAccountContract {
  id: string;
  displayName: string;
  status: 'active' | 'disabled';
  createdAt: string;
  disabledAt: string | null;
  disabledReason: string | null;
  identities: OperatorIdentityContract[];
  actions: OperatorActionContract[];
}

export interface OperatorListContract {
  operators: OperatorAccountContract[];
}

export interface OperatorCreateRequest {
  displayName: string;
  subject: string;
  actions: OperatorActionContract[];
  stepUpId: string;
}

export interface OperatorGrantsRequest {
  actions: OperatorActionContract[];
  stepUpId: string;
}

export interface OperatorRelinkRequest {
  subject: string;
  stepUpId: string;
}

export interface OperatorDisableRequest {
  reason: string;
  stepUpId: string;
}

export interface OperatorActivityEntryContract {
  id: string;
  at: string;
  operator: string;
  action: string;
  permission: string | null;
  requestId: string | null;
  issuer: string | null;
  subject: string | null;
  detail: unknown;
}

export interface OperatorActivityContract {
  entries: OperatorActivityEntryContract[];
}

export type OperatorAssuranceContract = 'aal1' | 'aal2' | 'aal3';

/** Every sign-in change carries a one-use step-up for the `sign_in` action and a reason kept in the audit. */
export interface OperatorSignInChange {
  reason: string;
  stepUpId: string;
}

export interface OperatorSignInPolicyRequest extends OperatorSignInChange {
  policy: { passwordEnabled: boolean; emailCodeEnabled: boolean; minimumAssurance: OperatorAssuranceContract };
}

/** An organisation's own OpenID Connect provider. Leave `clientSecret` out to keep the stored secret. */
export interface OperatorProviderRequest extends OperatorSignInChange {
  provider: { label: string; issuer: string; clientId: string; clientSecret?: string; allowedDomains: string[] };
}

export interface OperatorProviderPolicyRequest extends OperatorSignInChange {
  policy: { enabled: boolean; assurance: OperatorAssuranceContract; allowedDomains?: string[] };
}

export interface OperatorProviderOptInContract {
  enabled: boolean;
  assurance: OperatorAssuranceContract;
  allowedDomains: string[];
  updatedAt: string | null;
}

export interface OperatorSignInContract {
  organisation: { code: string; displayName: string; status: string };
  policy: { passwordEnabled: boolean; emailCodeEnabled: boolean; minimumAssurance: OperatorAssuranceContract };
  shared: { id: string; label: string; issuer: string; allowedDomains: string[]; optIn: OperatorProviderOptInContract | null }[];
  own: {
    id: string;
    label: string;
    issuer: string;
    clientId: string;
    allowedDomains: string[];
    secretSet: boolean;
    updatedAt: string;
    optIn: OperatorProviderOptInContract | null;
  }[];
}

export interface OperatorProviderCheckContract {
  ok: boolean;
  issuer: string;
  checks: { name: string; ok: boolean; message: string }[];
}
