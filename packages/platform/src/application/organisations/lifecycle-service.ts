import type { OnboardingRow, OperatorAuditActor, OrganisationLifecycle, OrganisationRow, PlatformAuditRow, TenantStatus } from '../../domain/organisations/ports/organisation-directory.js';
import { conflict, notFound, validationFailed } from '@onengo/kernel/errors';
import type { Logger } from '@onengo/kernel/ports';
import { legacyOperatorActor } from './onboarding-service.js';

export interface OrganisationStatus {
  organisation: {
    id: string;
    code: string;
    displayName: string;
    legalName: string | null;
    status: TenantStatus;
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
  /** Newest first: operator actions and provisioning steps. */
  history: { at: string; operator: string; action: string; detail: unknown }[];
}

const iso = (v: Date | null) => (v ? new Date(v).toISOString() : null);

function statusOf(org: OrganisationRow | undefined, onboarding: OnboardingRow | undefined, history: PlatformAuditRow[]): OrganisationStatus {
  return {
    organisation: org
      ? {
          id: org.id,
          code: org.key,
          displayName: org.name,
          legalName: org.legal_name,
          status: org.status,
          region: org.region,
          createdAt: iso(org.created_at)!,
          statusChangedAt: iso(org.status_changed_at),
        }
      : null,
    onboarding: onboarding
      ? {
          requestId: onboarding.request_id,
          state: onboarding.state,
          step: onboarding.step,
          invitation: onboarding.invitation,
          failure: onboarding.failure_code ? { code: onboarding.failure_code, message: onboarding.failure_message ?? '' } : null,
          requestedBy: onboarding.requested_by,
          createdAt: iso(onboarding.created_at)!,
          completedAt: iso(onboarding.completed_at),
        }
      : null,
    history: history.map((h) => ({ at: iso(h.at)!, operator: h.display_snapshot ?? h.operator, action: h.action, detail: h.detail })),
  };
}

function reasonOf(raw: string | undefined, required: boolean): string | null {
  const reason = raw?.trim() ?? '';
  if (!reason) {
    if (required) throw validationFailed('Give the reason, which is kept in the audit.', [{ path: 'reason', message: 'Required.' }]);
    return null;
  }
  if (reason.length > 500) throw validationFailed('The reason is at most 500 characters.', [{ path: 'reason', message: 'At most 500 characters.' }]);
  return reason;
}

/**
 * An authorised operator's view of an organisation and its lifecycle after
 * onboarding: suspend, reactivate and close. None of them deletes data.
 * Suspending ends every session and stops the organisation's API keys;
 * reactivating does not bring back sessions or credentials that ended.
 */
export class OrganisationLifecycleService {
  constructor(
    private readonly organisations: OrganisationLifecycle,
    private readonly logger: Logger,
  ) {}

  /** By organisation code, or by onboarding request id when the request made no organisation yet. */
  async status(ref: { code?: string; requestId?: string }): Promise<OrganisationStatus> {
    const code = ref.code?.trim().toLowerCase();
    let org = code ? await this.organisations.organisation(code) : undefined;
    const onboarding = org ? await this.organisations.onboardingFor(org.id) : ref.requestId ? await this.organisations.onboarding(ref.requestId.trim()) : undefined;
    if (!org && onboarding?.tenant_id) org = await this.organisations.organisation(onboarding.organisation_code);
    if (!org && !onboarding) throw notFound('There is no such organisation or onboarding request.');
    const history = await this.organisations.audit({ tenantId: org?.id, requestId: onboarding?.request_id }, 50);
    return statusOf(org, onboarding, history);
  }

  async suspend(operator: OperatorAuditActor | string, code: string, reason?: string): Promise<OrganisationStatus> {
    return this.move(operator, code, ['active'], 'suspended', 'organisation.suspended', reasonOf(reason, true), 'Only an active organisation can be suspended.');
  }

  async reactivate(operator: OperatorAuditActor | string, code: string, reason?: string): Promise<OrganisationStatus> {
    return this.move(operator, code, ['suspended'], 'active', 'organisation.reactivated', reasonOf(reason, false), 'Only a suspended organisation can be reactivated.');
  }

  /** Closing keeps every row for export and retention; a closed organisation does not open again. */
  async close(operator: OperatorAuditActor | string, code: string, reason?: string): Promise<OrganisationStatus> {
    return this.move(
      operator,
      code,
      ['suspended', 'provisioning_failed'],
      'closed',
      'organisation.closed',
      reasonOf(reason, true),
      'Suspend the organisation before closing it.',
    );
  }

  private async move(
    operator: OperatorAuditActor | string,
    code: string,
    from: TenantStatus[],
    to: TenantStatus,
    action: string,
    reason: string | null,
    refusal: string,
  ): Promise<OrganisationStatus> {
    const permission = action === 'organisation.suspended' ? 'suspend' : action === 'organisation.reactivated' ? 'reactivate' : 'close';
    const op = typeof operator === 'string' ? legacyOperatorActor(operator, permission) : operator;
    const org = await this.organisations.organisation(code.trim().toLowerCase());
    if (!org) throw notFound('There is no such organisation.');
    if (!(await this.organisations.transition(org.id, from, to, op, action, reason))) throw conflict(`${refusal} This one is ${org.status.replace('_', ' ')}.`);
    this.logger.log('NOTICE', 'organisation status changed', { tenantId: org.id, from: org.status, to, action });
    return this.status({ code: org.key });
  }
}
