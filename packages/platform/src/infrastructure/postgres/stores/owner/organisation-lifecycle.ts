import { SYSTEM_ACTOR_PREFIX, type Database, type SqlExecutor } from '../../db.js';
import { typed } from '../../kysely.js';
import { NOW } from '../../sql-fragments.js';
import type { OrganisationLifecycle, OperatorAuditActor, TenantStatus, OnboardingState, InvitationState, OnboardingRow } from '../../../../domain/organisations/ports/organisation-directory.js';

const selectOnboarding = (tx: SqlExecutor) =>
  typed(tx)
    .selectFrom('organisation_onboarding')
    .select([
      'request_id',
      'organisation_code',
      'input',
      'input_sha256',
      'state',
      'step',
      'tenant_id',
      'administrator_id',
      'invitation',
      'failure_code',
      'failure_message',
      'requested_by',
      'created_at',
      'updated_at',
      'completed_at',
    ])
    .$narrowType<{ state: OnboardingState; invitation: InvitationState }>();

const selectOrganisation = (tx: SqlExecutor) =>
  typed(tx)
    .selectFrom('tenant')
    .select(['id', 'key', 'name', 'legal_name', 'status', 'region', 'created_at', 'status_changed_at'])
    .$narrowType<{ status: TenantStatus }>();

async function platformAudit(
  tx: SqlExecutor,
  e: { operator: OperatorAuditActor; action: string; tenantId?: string | null; requestId?: string; detail?: unknown },
): Promise<void> {
  await typed(tx)
    .insertInto('platform_audit')
    .values({
      operator: e.operator.display,
      operator_account_id: e.operator.operatorId,
      issuer: e.operator.issuer,
      subject: e.operator.subject,
      display_snapshot: e.operator.display,
      permission: e.operator.permission,
      auth_time: e.operator.authTime,
      assurance: e.operator.assurance,
      amr: e.operator.amr,
      acr: e.operator.acr,
      operator_session_id: e.operator.sessionId,
      step_up_id: e.operator.stepUpId,
      action: e.action,
      tenant_id: e.tenantId ?? null,
      request_id: e.requestId ?? null,
      detail: e.detail === undefined ? null : JSON.stringify(e.detail),
    })
    .execute();
}

/** The organisation's own audit log shows what the operator did to it, under the organisation area. */
async function tenantAudit(tx: SqlExecutor, tenantId: string, operator: OperatorAuditActor, action: string, after?: unknown): Promise<void> {
  await typed(tx)
    .insertInto('audit_event')
    .values({
      tenant_id: tenantId,
      actor_id: `${SYSTEM_ACTOR_PREFIX}operator:${operator.operatorId ?? operator.display}`,
      action,
      entity: 'tenant',
      entity_id: tenantId,
      after: after === undefined ? null : JSON.stringify(after),
    })
    .execute();
}


/** The owner-level organisations capability. */
export function pgOrganisationLifecycle(db: Database): OrganisationLifecycle {
  return {
    onboarding(requestId) {
      return db.asSystem((tx) => selectOnboarding(tx).where('request_id', '=', requestId).executeTakeFirst());
    },
    async codeTaken(code, requestId) {
      const row = await db.asSystem((tx) => {
        const k = typed(tx);
        return k
          .selectNoFrom((eb) => [
            eb
              .exists(
                k
                  .selectFrom('tenant as t')
                  .select(eb.lit(1).as('one'))
                  .where('t.key', '=', code)
                  .where((w) =>
                    w.not(
                      w.exists(
                        w.selectFrom('organisation_onboarding as o').select(w.lit(1).as('one')).whereRef('o.tenant_id', '=', 't.id').where('o.request_id', '=', requestId),
                      ),
                    ),
                  ),
              )
              .as('tenant'),
            eb
              .exists(k.selectFrom('organisation_onboarding').select(eb.lit(1).as('one')).where('organisation_code', '=', code).where('request_id', '<>', requestId))
              .as('request'),
          ])
          .executeTakeFirstOrThrow();
      });
      return Boolean(row.tenant || row.request);
    },
    startOnboarding({ requestId, code, input, inputSha256, operator }) {
      return db.asSystem(async (tx) => {
        const inserted = await typed(tx)
          .insertInto('organisation_onboarding')
          .values({
            request_id: requestId,
            organisation_code: code,
            input: JSON.stringify(input),
            input_sha256: inputSha256,
            requested_by: operator.display,
            updated_by: operator.display,
            requested_by_operator_id: operator.operatorId,
            updated_by_operator_id: operator.operatorId,
          })
          .onConflict((oc) => oc.column('request_id').doNothing())
          .returning('request_id')
          .executeTakeFirst();
        if (inserted) await platformAudit(tx, { operator, action: 'onboarding.requested', requestId, detail: { code } });
        return (await selectOnboarding(tx).where('request_id', '=', requestId).executeTakeFirstOrThrow()) as OnboardingRow;
      });
    },
    createTenant(requestId, operator, o) {
      return db.asSystem(async (tx) => {
        const k = typed(tx);
        const request = await k.selectFrom('organisation_onboarding').select('tenant_id').where('request_id', '=', requestId).forUpdate().executeTakeFirstOrThrow();
        if (request.tenant_id) return request.tenant_id;
        const tenant = await k
          .insertInto('tenant')
          .values({ key: o.key, name: o.name, legal_name: o.legalName, region: o.region, default_locale: o.defaultLanguage, status: 'provisioning', status_changed_at: NOW })
          .returning('id')
          .executeTakeFirstOrThrow();
        await k.updateTable('organisation_onboarding').set({ tenant_id: tenant.id, step: 'tenant', updated_by: operator.display, updated_by_operator_id: operator.operatorId, updated_at: NOW }).where('request_id', '=', requestId).execute();
        await platformAudit(tx, { operator, action: 'onboarding.step', tenantId: tenant.id, requestId, detail: { step: 'tenant', status: 'provisioning' } });
        return tenant.id;
      });
    },
    async recordStep(requestId, operator, step, changes = {}) {
      await db.asSystem(async (tx) => {
        const row = await typed(tx)
          .updateTable('organisation_onboarding')
          .set({
            step,
            updated_by: operator.display,
            updated_by_operator_id: operator.operatorId,
            updated_at: NOW,
            ...(changes.input === undefined ? {} : { input: JSON.stringify(changes.input) }),
            ...(changes.administratorId === undefined ? {} : { administrator_id: changes.administratorId }),
          })
          .where('request_id', '=', requestId)
          .returning('tenant_id')
          .executeTakeFirstOrThrow();
        await platformAudit(tx, { operator, action: 'onboarding.step', tenantId: row.tenant_id, requestId, detail: { step } });
      });
    },
    async resume(requestId, operator) {
      await db.asSystem(async (tx) => {
        const k = typed(tx);
        const row = await k
          .updateTable('organisation_onboarding')
          .set({ state: 'provisioning', failure_code: null, failure_message: null, updated_by: operator.display, updated_by_operator_id: operator.operatorId, updated_at: NOW })
          .where('request_id', '=', requestId)
          .where('state', '=', 'provisioning_failed')
          .returning('tenant_id')
          .executeTakeFirst();
        if (!row) return;
        if (row.tenant_id) {
          await k.updateTable('tenant').set({ status: 'provisioning', status_changed_at: NOW }).where('id', '=', row.tenant_id).where('status', '=', 'provisioning_failed').execute();
        }
        await platformAudit(tx, { operator, action: 'onboarding.retried', tenantId: row.tenant_id, requestId });
      });
    },
    async recordFailure(requestId, operator, code, message) {
      await db.asSystem(async (tx) => {
        const k = typed(tx);
        const row = await k
          .updateTable('organisation_onboarding')
          .set({ state: 'provisioning_failed', failure_code: code, failure_message: message, updated_by: operator.display, updated_by_operator_id: operator.operatorId, updated_at: NOW })
          .where('request_id', '=', requestId)
          .where('state', '=', 'provisioning')
          .returning(['tenant_id', 'step'])
          .executeTakeFirst();
        if (!row) return;
        if (row.tenant_id) {
          await k.updateTable('tenant').set({ status: 'provisioning_failed', status_changed_at: NOW }).where('id', '=', row.tenant_id).where('status', '=', 'provisioning').execute();
        }
        await platformAudit(tx, { operator, action: 'onboarding.failed', tenantId: row.tenant_id, requestId, detail: { step: row.step, code } });
      });
    },
    async activate(requestId, operator) {
      await db.asSystem(async (tx) => {
        const k = typed(tx);
        const row = await k
          .updateTable('organisation_onboarding')
          .set({ state: 'active', step: 'active', updated_by: operator.display, updated_by_operator_id: operator.operatorId, updated_at: NOW, completed_at: NOW })
          .where('request_id', '=', requestId)
          .where('state', '=', 'provisioning')
          .where('tenant_id', 'is not', null)
          .returning('tenant_id')
          .executeTakeFirst();
        if (!row) throw new Error(`Onboarding request ${requestId} is not provisioning an organisation.`);
        const tenantId = row.tenant_id!;
        await k.updateTable('tenant').set({ status: 'active', status_changed_at: NOW }).where('id', '=', tenantId).where('status', '=', 'provisioning').executeTakeFirstOrThrow();
        await platformAudit(tx, { operator, action: 'organisation.activated', tenantId, requestId });
        await tenantAudit(tx, tenantId, operator, 'organisation.activated');
      });
    },
    async recordInvitation(requestId, operator, outcome, message) {
      await db.asSystem(async (tx) => {
        const row = await typed(tx)
          .updateTable('organisation_onboarding')
          .set({ invitation: outcome, updated_by: operator.display, updated_by_operator_id: operator.operatorId, updated_at: NOW })
          .where('request_id', '=', requestId)
          .returning('tenant_id')
          .executeTakeFirstOrThrow();
        await platformAudit(tx, {
          operator,
          action: outcome === 'sent' ? 'onboarding.invitation.sent' : 'onboarding.invitation.failed',
          tenantId: row.tenant_id,
          requestId,
          detail: message ? { message } : undefined,
        });
      });
    },
    organisation(key) {
      return db.asSystem((tx) => selectOrganisation(tx).where('key', '=', key).executeTakeFirst());
    },
    onboardingFor(tenantId) {
      return db.asSystem((tx) => selectOnboarding(tx).where('tenant_id', '=', tenantId).executeTakeFirst());
    },
    transition(tenantId, from, to, operator, action, reason) {
      return db.asSystem(async (tx) => {
        const k = typed(tx);
        const before = await k.selectFrom('tenant').select('status').where('id', '=', tenantId).forUpdate().executeTakeFirst();
        if (!before || !(from as string[]).includes(before.status)) return false;
        await k
          .updateTable('tenant')
          .set((eb) => ({ status: to, status_changed_at: NOW, access_version: eb('access_version', '+', eb.lit(1)) }))
          .where('id', '=', tenantId)
          .execute();
        if (before.status === 'active') {
          await k.updateTable('refresh_token').set({ revoked_at: NOW }).where('tenant_id', '=', tenantId).where('revoked_at', 'is', null).execute();
        }
        const detail = { from: before.status, to, ...(reason ? { reason } : {}) };
        await platformAudit(tx, { operator, action, tenantId, detail });
        await tenantAudit(tx, tenantId, operator, action, detail);
        return true;
      });
    },
    async recordChange(tenantId, operator, action, detail) {
      await db.asSystem(async (tx) => {
        await typed(tx)
          .updateTable('tenant')
          .set((eb) => ({ access_version: eb('access_version', '+', eb.lit(1)) }))
          .where('id', '=', tenantId)
          .executeTakeFirstOrThrow();
        await platformAudit(tx, { operator, action, tenantId, detail });
        await tenantAudit(tx, tenantId, operator, action, detail);
      });
    },
    async audit(filter, limit) {
      const rows = await db.asSystem((tx) =>
        typed(tx)
          .selectFrom('platform_audit')
          .select([
            'id',
            'operator',
            'operator_account_id',
            'issuer',
            'subject',
            'display_snapshot',
            'permission',
            'auth_time',
            'assurance',
            'amr',
            'acr',
            'operator_session_id',
            'step_up_id',
            'action',
            'tenant_id',
            'request_id',
            'detail',
            'at',
          ])
          .where((eb) =>
            eb.or([
              ...(filter.tenantId ? [eb('tenant_id', '=', filter.tenantId)] : []),
              ...(filter.requestId ? [eb('request_id', '=', filter.requestId)] : []),
            ]),
          )
          .orderBy('at', 'desc')
          .orderBy('id', 'desc')
          .limit(limit)
          .execute(),
      );
      return rows.map((r) => ({ ...r, id: String(r.id) }));
    },
  };
}
