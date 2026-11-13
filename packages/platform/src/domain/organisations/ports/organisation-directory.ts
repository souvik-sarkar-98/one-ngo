/** The organisation directory the owner-level database capability provides: found by key, onboarding requests and lifecycle. */
/** Organisations as a whole: found by key, listed, and the columns of the organisation row itself. */
export interface TenantDirectory {
  /** The active organisation with this key. */
  activeIdByKey(key: string): Promise<string | undefined>;
  activeIds(): Promise<string[]>;
  /** Active organisations, least recently ticked first. */
  activeIdsByTickOrder(): Promise<string[]>;
  markTicked(tenantId: string, at: Date): Promise<void>;
  /** Any organisation's key and name, whatever its status. */
  keyAndName(tenantId: string): Promise<{ key: string; name: string } | undefined>;
  /** Changes the display name, legal name and default language; an undefined value keeps the current one. */
  updateIdentity(tenantId: string, changes: { name?: string; legalName?: string; defaultLanguage?: string }): Promise<void>;
}

export type TenantStatus = 'provisioning' | 'active' | 'provisioning_failed' | 'suspended' | 'closed';
export type OnboardingState = 'provisioning' | 'provisioning_failed' | 'active';
export type InvitationState = 'pending' | 'sent' | 'failed';

/** Structured evidence attached to every verified control-plane write. */
export interface OperatorAuditActor {
  display: string;
  operatorId: string | null;
  issuer: string | null;
  subject: string | null;
  permission: string | null;
  authTime: string | null;
  assurance: string | null;
  amr: string[] | null;
  acr: string | null;
  sessionId: string | null;
  stepUpId: string | null;
}

export interface OnboardingRow {
  request_id: string;
  organisation_code: string;
  input: unknown;
  input_sha256: string;
  state: OnboardingState;
  step: string;
  tenant_id: string | null;
  administrator_id: string | null;
  invitation: InvitationState;
  failure_code: string | null;
  failure_message: string | null;
  requested_by: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface OrganisationRow {
  id: string;
  key: string;
  name: string;
  legal_name: string | null;
  status: TenantStatus;
  region: string | null;
  created_at: Date;
  status_changed_at: Date | null;
}

export interface PlatformAuditRow {
  id: string;
  operator: string;
  operator_account_id: string | null;
  issuer: string | null;
  subject: string | null;
  display_snapshot: string | null;
  permission: string | null;
  auth_time: Date | null;
  assurance: string | null;
  amr: string[] | null;
  acr: string | null;
  operator_session_id: string | null;
  step_up_id: string | null;
  action: string;
  tenant_id: string | null;
  request_id: string | null;
  detail: unknown;
  at: Date;
}

export interface NewOrganisation {
  key: string;
  name: string;
  legalName: string;
  region: string;
  defaultLanguage: string;
}

/**
 * Onboarding requests, organisation status and the platform audit: the
 * operator's side of organisations, which no tenant transaction can reach.
 * Every change here writes a platform audit entry in the same transaction.
 */
export interface OrganisationLifecycle {
  onboarding(requestId: string): Promise<OnboardingRow | undefined>;
  /** Whether an organisation other than the one `requestId` created, or another request, already holds the code. */
  codeTaken(code: string, requestId: string): Promise<boolean>;
  /** Records the request; when one with this id exists it is returned unchanged. */
  startOnboarding(input: { requestId: string; code: string; input: unknown; inputSha256: string; operator: OperatorAuditActor }): Promise<OnboardingRow>;
  /** Creates the organisation in `provisioning` for the request, unless it already has one; returns its id. */
  createTenant(requestId: string, operator: OperatorAuditActor, organisation: NewOrganisation): Promise<string>;
  /** Records a finished step; `input` replaces the stored request when given. */
  recordStep(requestId: string, operator: OperatorAuditActor, step: string, changes?: { input?: unknown; administratorId?: string }): Promise<void>;
  /** Back to `provisioning` from a failure, to run the remaining steps. */
  resume(requestId: string, operator: OperatorAuditActor): Promise<void>;
  /** The request and its organisation become `provisioning_failed`, with a message safe to show. */
  recordFailure(requestId: string, operator: OperatorAuditActor, code: string, message: string): Promise<void>;
  /** The organisation becomes active and the request finished, in one transaction. */
  activate(requestId: string, operator: OperatorAuditActor): Promise<void>;
  recordInvitation(requestId: string, operator: OperatorAuditActor, outcome: Exclude<InvitationState, 'pending'>, message?: string): Promise<void>;
  organisation(key: string): Promise<OrganisationRow | undefined>;
  onboardingFor(tenantId: string): Promise<OnboardingRow | undefined>;
  /**
   * Moves the organisation from one of `from` to `to` and returns true, or
   * returns false when it is in none of them. Leaving `active` ends every
   * session of the organisation.
   */
  transition(tenantId: string, from: TenantStatus[], to: TenantStatus, operator: OperatorAuditActor, action: string, reason: string | null): Promise<boolean>;
  /**
   * Records an operator change to an organisation's settings in the platform audit and the organisation's own
   * audit, and bumps its access version so every server reloads cached sign-in state. `detail` never holds secrets.
   */
  recordChange(tenantId: string, operator: OperatorAuditActor, action: string, detail: unknown): Promise<void>;
  /** Newest first. */
  audit(filter: { tenantId?: string; requestId?: string }, limit: number): Promise<PlatformAuditRow[]>;
}
