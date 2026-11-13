import {
  duplicateRegistrations,
  isTimezone,
  knownKeys,
  organisationCode,
  parseAddress,
  parseContact,
  parseRegistration,
  type OrganisationAddress,
  type OrganisationContact,
  type RegistrationInput,
} from '../../domain/organisations/organisation.js';
import type { InvitationState, OnboardingRow, OperatorAuditActor, OrganisationLifecycle, TenantStatus } from '../../domain/organisations/ports/organisation-directory.js';
import { createHash } from 'node:crypto';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { systemActor } from '../../domain/system-actor.js';
import { conflict, notFound, PlatformError, validationFailed, type FieldIssue } from '@onengo/kernel/errors';
import type { Logger } from '@onengo/kernel/ports';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import { isFiscalYearKey } from '../../domain/ledger/fiscal-year.js';
import { stableStringify } from '../../runtime/definitions/definition-service.js';
import { SHIPPED_LOCALES } from '../../runtime/definitions/messages.js';
import type { ModuleManifest } from '../../runtime/definitions/types.js';
import type { FiscalYearOpener, ModuleEnabler, OnboardingIdentity } from './ports/organisation-ports.js';
import type { OnboardingStore } from './ports/onboarding-store.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/;
const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._@+-]{2,119}$/;
const REGION = /^[a-z][a-z0-9-]{1,39}$/;
const MODULE_KEY = /^[a-z][a-z0-9-]{0,39}$/;
/** A receipt number is `<prefix>/<year>/<seq>`, so the prefix cannot hold `/`. */
const RECEIPT_PREFIX = /^[A-Z0-9][A-Z0-9-]{0,11}$/;
const MAX_REGISTRATIONS = 20;

export const ADMINISTRATOR_ROLE = { key: 'admin', label: 'Organisation administrator', permissions: ['*'] };

/** In order; a request records the last one it finished and resumes after it. */
export const ONBOARDING_STEPS = ['requested', 'tenant', 'profile', 'administrator-role', 'modules', 'receipt-prefix', 'fiscal-year', 'administrator', 'readiness', 'active'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The validated onboarding request, as stored with it. */
export interface OnboardingPlan {
  requestId: string;
  organisation: {
    code: string;
    displayName: string;
    legalName: string;
    contact: OrganisationContact;
    address: OrganisationAddress;
    timezone: string;
    defaultLanguage: string;
    region: string;
    registrations: RegistrationInput[];
  };
  administrator: { name: string; email: string };
  modules: string[];
  financialYear: { startMonth: number; current: string };
  receiptPrefix: string | null;
}

export interface OnboardingOutcome {
  requestId: string;
  code: string;
  organisationId: string | null;
  /** `valid`: checked only, nothing written. */
  status: TenantStatus | 'not_created' | 'valid';
  step: string;
  invitation: InvitationState;
  failure: { code: string; message: string } | null;
}

/** Finds a shipped module the deploy step has published. */
export type ShippedModules = (key: string) => Promise<ModuleManifest | undefined>;

/** Validates an internal operator audit label; never a tenant actor. */
export function operatorId(raw: string | undefined): string {
  const id = raw?.trim() ?? '';
  if (!OPERATOR.test(id)) throw validationFailed('The operator audit identity must be 3 to 120 letters, digits or . _ @ + -.');
  return id;
}

/** Test/deployment compatibility actor; serving requests use a verified OperatorPrincipal. */
export function legacyOperatorActor(raw: string | undefined, permission: string): OperatorAuditActor {
  return {
    display: operatorId(raw),
    operatorId: null,
    issuer: null,
    subject: null,
    permission,
    authTime: null,
    assurance: null,
    amr: null,
    acr: null,
    sessionId: null,
    stepUpId: null,
  };
}

const operatorActor = (operator: OperatorAuditActor | string, permission: string) =>
  typeof operator === 'string' ? legacyOperatorActor(operator, permission) : operator;

class ReadinessFailed extends PlatformError {
  constructor(readonly checks: string[]) {
    super('rule_violation', `Setup is not complete: ${checks.join(', ')}.`);
  }
}

function plainText(value: unknown, path: string, issues: FieldIssue[], max: number, label: string): string {
  const v = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!v) issues.push({ path, message: `${label} is required.` });
  else if (v.length > max) issues.push({ path, message: `${label} is at most ${max} characters.` });
  return v;
}

/**
 * The only service that creates organisations. One approved request creates
 * exactly one organisation, with its profile, administrator role, modules,
 * financial year and primary administrator, in resumable steps: each step is
 * safe to run again, and the request records the last one finished. Running
 * the same request again resumes it, or returns the organisation it made.
 * Nothing here is reachable over HTTP: the operator command calls it.
 */
export class OrganisationOnboardingService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: OnboardingStore,
    private readonly organisations: OrganisationLifecycle,
    private readonly definitions: ModuleEnabler,
    private readonly identity: OnboardingIdentity,
    private readonly ledger: FiscalYearOpener,
    private readonly modules: ShippedModules,
    private readonly logger: Logger,
  ) {}

  /** Checks the whole request before anything is written; every problem comes back as a field issue. */
  async validate(input: unknown): Promise<OnboardingPlan> {
    const issues: FieldIssue[] = [];
    if (!knownKeys(input, '', ['requestId', 'organisation', 'administrator', 'modules', 'financialYear', 'receiptPrefix'], issues)) {
      throw validationFailed('The onboarding request is not valid.', issues);
    }
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : '';
    if (!REQUEST_ID.test(requestId)) issues.push({ path: 'requestId', message: 'An approved request id of 3 to 100 letters, digits or . _ : -.' });

    const o = input.organisation;
    const org = knownKeys(o, 'organisation', ['code', 'displayName', 'legalName', 'contact', 'address', 'timezone', 'defaultLanguage', 'region', 'registrations'], issues)
      ? o
      : ({} as Record<string, unknown>);
    const code = organisationCode(org.code);
    if (!code) {
      issues.push({ path: 'organisation.code', message: 'An organisation code of 3 to 40 lowercase letters, digits or single dashes, starting with a letter; some words are reserved.' });
    }
    const displayName = plainText(org.displayName, 'organisation.displayName', issues, 120, 'The display name');
    const legalName = plainText(org.legalName, 'organisation.legalName', issues, 200, 'The legal name');
    const contact = parseContact(org.contact, 'organisation.contact', issues, true);
    const address = parseAddress(org.address, 'organisation.address', issues);
    const timezone = typeof org.timezone === 'string' ? org.timezone.trim() : '';
    if (!isTimezone(timezone)) issues.push({ path: 'organisation.timezone', message: 'A time zone such as Asia/Kolkata.' });
    const defaultLanguage = typeof org.defaultLanguage === 'string' ? org.defaultLanguage : '';
    if (!(SHIPPED_LOCALES as readonly string[]).includes(defaultLanguage)) {
      issues.push({ path: 'organisation.defaultLanguage', message: `One of ${SHIPPED_LOCALES.join(', ')}.` });
    }
    const region = typeof org.region === 'string' ? org.region.trim() : '';
    if (!REGION.test(region)) issues.push({ path: 'organisation.region', message: 'The hosting region, e.g. asia-south1.' });
    const registrations: (RegistrationInput | null)[] = [];
    if (org.registrations !== undefined) {
      if (!Array.isArray(org.registrations) || org.registrations.length > MAX_REGISTRATIONS) {
        issues.push({ path: 'organisation.registrations', message: `A list of at most ${MAX_REGISTRATIONS} registrations.` });
      } else {
        org.registrations.forEach((r, i) => registrations.push(parseRegistration(r, `organisation.registrations[${i}]`, issues)));
        issues.push(...duplicateRegistrations(registrations, 'organisation.registrations'));
      }
    }

    const a = input.administrator;
    const admin = knownKeys(a, 'administrator', ['name', 'email'], issues) ? a : ({} as Record<string, unknown>);
    const adminName = plainText(admin.name, 'administrator.name', issues, 120, 'The administrator’s name');
    const adminEmail = typeof admin.email === 'string' ? admin.email.trim().toLowerCase() : '';
    if (!EMAIL.test(adminEmail) || adminEmail.length > 254) issues.push({ path: 'administrator.email', message: 'A valid email address.' });

    const modules: string[] = [];
    const manifests: ModuleManifest[] = [];
    if (!Array.isArray(input.modules) || input.modules.length > 20) {
      issues.push({ path: 'modules', message: 'A list of shipped module keys, possibly empty.' });
    } else {
      for (const [i, key] of input.modules.entries()) {
        const manifest = typeof key === 'string' && MODULE_KEY.test(key) ? await this.modules(key) : undefined;
        if (!manifest) issues.push({ path: `modules[${i}]`, message: 'Not a module this installation ships and has published.' });
        else if (modules.includes(manifest.key)) issues.push({ path: `modules[${i}]`, message: 'Listed twice.' });
        else {
          modules.push(manifest.key);
          manifests.push(manifest);
        }
      }
      for (const [i, m] of manifests.entries()) {
        for (const dep of m.dependsOn ?? []) {
          if (!modules.includes(dep)) issues.push({ path: `modules[${i}]`, message: `Needs the module '${dep}' too.` });
        }
      }
    }

    const fy = input.financialYear;
    const year = knownKeys(fy, 'financialYear', ['startMonth', 'current'], issues) ? fy : ({} as Record<string, unknown>);
    const startMonth = year.startMonth;
    const monthOk = typeof startMonth === 'number' && Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12;
    if (!monthOk) issues.push({ path: 'financialYear.startMonth', message: 'The month the financial year starts, 1 (January) to 12.' });
    const current = typeof year.current === 'string' ? year.current : '';
    if (monthOk && !isFiscalYearKey(current, startMonth)) {
      issues.push({ path: 'financialYear.current', message: startMonth === 1 ? 'The year to open, e.g. 2026.' : 'The year to open, e.g. 2026-27.' });
    }

    let receiptPrefix: string | null = null;
    if (input.receiptPrefix !== undefined && input.receiptPrefix !== null) {
      receiptPrefix = typeof input.receiptPrefix === 'string' ? input.receiptPrefix.trim().toUpperCase() : '';
      if (!RECEIPT_PREFIX.test(receiptPrefix)) issues.push({ path: 'receiptPrefix', message: '1 to 12 capital letters, digits or dashes, starting with a letter or digit.' });
      else if (!manifests.some((m) => m.setup?.receiptSeries?.length)) issues.push({ path: 'receiptPrefix', message: 'None of the modules issues receipts.' });
    }

    if (code && REQUEST_ID.test(requestId) && (await this.organisations.codeTaken(code, requestId))) {
      issues.push({ path: 'organisation.code', message: 'Another organisation or onboarding request already uses this code.' });
    }
    if (issues.length) throw validationFailed('The onboarding request is not valid.', issues);
    return {
      requestId,
      organisation: {
        code: code!,
        displayName,
        legalName,
        contact,
        address: address!,
        timezone,
        defaultLanguage,
        region,
        registrations: registrations as RegistrationInput[],
      },
      administrator: { name: adminName, email: adminEmail },
      modules,
      financialYear: { startMonth: startMonth as number, current },
      receiptPrefix,
    };
  }

  /**
   * Provisions the request, or resumes it. The same request id with different
   * contents is refused. `validateOnly` checks the request and writes nothing.
   */
  async onboard(operator: OperatorAuditActor | string, input: unknown, options: { validateOnly?: boolean } = {}): Promise<OnboardingOutcome> {
    const op = operatorActor(operator, 'onboard');
    const plan = await this.validate(input);
    if (options.validateOnly) {
      return { requestId: plan.requestId, code: plan.organisation.code, organisationId: null, status: 'valid', step: 'none', invitation: 'pending', failure: null };
    }
    const digest = createHash('sha256').update(stableStringify(plan)).digest('hex');
    const existing = await this.organisations.onboarding(plan.requestId);
    if (existing && existing.input_sha256 !== digest) throw conflict(`Request ${plan.requestId} was already used for a different onboarding request.`);
    const row = existing ?? (await this.organisations.startOnboarding({ requestId: plan.requestId, code: plan.organisation.code, input: plan, inputSha256: digest, operator: op }));
    return this.run(op, row);
  }

  /** Resumes a failed or interrupted request, or sends a failed invitation again. */
  async retry(operator: OperatorAuditActor | string, requestId: string): Promise<OnboardingOutcome> {
    const op = operatorActor(operator, 'retry');
    const row = REQUEST_ID.test(requestId) ? await this.organisations.onboarding(requestId) : undefined;
    if (!row) throw notFound(`There is no onboarding request ${requestId}.`);
    return this.run(op, row);
  }

  // --------------------------------------------------------------- internals

  private async run(op: OperatorAuditActor, row: OnboardingRow): Promise<OnboardingOutcome> {
    let plan = row.input as OnboardingPlan;
    if (row.state !== 'active') {
      if (row.state === 'provisioning_failed') await this.organisations.resume(row.request_id, op);
      let tenantId = row.tenant_id;
      let administratorId = row.administrator_id;
      let step = row.step as OnboardingStep;
      try {
        for (const next of ONBOARDING_STEPS.slice(ONBOARDING_STEPS.indexOf(step) + 1)) {
          step = next;
          if (next === 'tenant') {
            tenantId = await this.organisations.createTenant(row.request_id, op, {
              key: plan.organisation.code,
              name: plan.organisation.displayName,
              legalName: plan.organisation.legalName,
              region: plan.organisation.region,
              defaultLanguage: plan.organisation.defaultLanguage,
            });
            continue;
          }
          if (next === 'active') {
            await this.organisations.activate(row.request_id, op);
            this.logger.log('INFO', 'organisation activated', { requestId: row.request_id, tenantId: tenantId! });
            continue;
          }
          const ctx: TenantContext = { tenantId: tenantId!, actor: systemActor('onboarding') };
          const changes: { input?: OnboardingPlan; administratorId?: string } = {};
          if (next === 'profile') {
            await this.saveProfile(ctx, plan);
            plan = this.minimised(plan);
            changes.input = plan;
          } else if (next === 'administrator-role') await this.identity.upsertRole(ctx, ADMINISTRATOR_ROLE);
          else if (next === 'modules') await this.enableModules(ctx, plan);
          else if (next === 'receipt-prefix') await this.applyReceiptPrefix(ctx, plan);
          else if (next === 'fiscal-year') await this.openFiscalYear(ctx, plan);
          else if (next === 'administrator') administratorId = changes.administratorId = await this.addAdministrator(ctx, plan);
          else if (next === 'readiness') {
            const failing = await this.readiness(ctx, plan, administratorId!);
            if (failing.length) throw new ReadinessFailed(failing);
          }
          await this.organisations.recordStep(row.request_id, op, next, changes);
          this.logger.log('INFO', 'onboarding step finished', { requestId: row.request_id, tenantId: tenantId!, step: next });
        }
      } catch (error) {
        const code = error instanceof ReadinessFailed ? 'readiness' : error instanceof PlatformError ? error.code : 'internal';
        const message = error instanceof PlatformError ? error.message : 'Provisioning stopped unexpectedly. Retry the request; finished steps are not repeated.';
        this.logger.log('ERROR', 'Provisioning failed', { requestId: row.request_id, tenantId: tenantId ?? '', step, code }, error instanceof PlatformError ? undefined : error);
        await this.organisations.recordFailure(row.request_id, op, code, message);
        return this.outcome(row.request_id);
      }
    }
    const current = (await this.organisations.onboarding(row.request_id))!;
    if (current.invitation !== 'sent') await this.invite(op, current);
    return this.outcome(row.request_id);
  }

  /** After the organisation is active and every step has committed. A failure is recorded; retrying sends it again. */
  private async invite(op: OperatorAuditActor, row: OnboardingRow): Promise<void> {
    try {
      await this.identity.inviteMember({ tenantId: row.tenant_id!, actor: systemActor('onboarding') }, row.administrator_id!);
      await this.organisations.recordInvitation(row.request_id, op, 'sent');
    } catch (error) {
      const message = error instanceof PlatformError ? error.message : 'The invitation could not be sent.';
      this.logger.log('WARNING', 'Invitation to the primary administrator failed', { requestId: row.request_id, tenantId: row.tenant_id! }, error instanceof PlatformError ? undefined : error);
      await this.organisations.recordInvitation(row.request_id, op, 'failed', message);
    }
  }

  private async outcome(requestId: string): Promise<OnboardingOutcome> {
    const row = (await this.organisations.onboarding(requestId))!;
    const tenant = row.tenant_id ? await this.organisations.organisation(row.organisation_code) : undefined;
    return {
      requestId,
      code: row.organisation_code,
      organisationId: row.tenant_id,
      status: tenant?.status ?? 'not_created',
      step: row.step,
      invitation: row.invitation,
      failure: row.failure_code ? { code: row.failure_code, message: row.failure_message ?? '' } : null,
    };
  }

  /** Once saved in the organisation, the contact, address and registrations are not kept in the request as well. */
  private minimised(plan: OnboardingPlan): OnboardingPlan {
    return {
      ...plan,
      organisation: {
        ...plan.organisation,
        contact: { email: null, phone: null, website: null },
        address: { line1: '', line2: null, city: '', state: null, postalCode: '', country: plan.organisation.address.country },
        registrations: [],
      },
    };
  }

  private async saveProfile(ctx: TenantContext, plan: OnboardingPlan): Promise<void> {
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const o = plan.organisation;
      await this.store.writeProfile(tx, ctx.actor.id, { contact: o.contact, address: o.address, timezone: o.timezone });
      for (const r of o.registrations) await this.store.addRegistration(tx, ctx.actor.id, r);
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'organisation.profile.changed',
        entity: 'tenant',
        entityId: ctx.tenantId,
        after: { registrations: o.registrations.length },
      });
    });
  }

  private async manifest(key: string): Promise<ModuleManifest> {
    const manifest = await this.modules(key);
    if (!manifest) throw validationFailed(`The module '${key}' is no longer published by this installation.`);
    return manifest;
  }

  private async enableModules(ctx: TenantContext, plan: OnboardingPlan): Promise<void> {
    for (const key of plan.modules) await this.definitions.enableModule(ctx, await this.manifest(key));
  }

  /** The shipped files keep their prefix; the organisation's own series rows take the requested one while nothing is numbered yet. */
  private async applyReceiptPrefix(ctx: TenantContext, plan: OnboardingPlan): Promise<void> {
    if (!plan.receiptPrefix) return;
    const series: string[] = [];
    for (const key of plan.modules) series.push(...((await this.manifest(key)).setup?.receiptSeries ?? []).map((s) => s.key));
    if (!series.length) return;
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const changed = await this.store.setReceiptPrefix(tx, plan.receiptPrefix!, series);
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'receipt_series.prefix.set',
        entity: 'receipt',
        entityId: null,
        after: { prefix: plan.receiptPrefix, series: changed },
      });
    });
  }

  /** Sets the organisation's start month (D10) before the year opens, which fixes it. */
  private async openFiscalYear(ctx: TenantContext, plan: OnboardingPlan): Promise<void> {
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      if (!(await this.store.fiscalYearOpened(tx, plan.financialYear.current))) await this.store.setFiscalYearStart(tx, plan.financialYear.startMonth, ctx.actor.id);
      await this.ledger.openFiscalYear(tx, ctx.actor, plan.financialYear.current);
    });
  }

  /** Creates the account or reuses the one with this email; membership and the role are only in the new organisation. */
  private async addAdministrator(ctx: TenantContext, plan: OnboardingPlan): Promise<string> {
    return this.identity.addMember(ctx, { email: plan.administrator.email, displayName: plan.administrator.name, roles: [ADMINISTRATOR_ROLE.key] });
  }

  /** What must hold before the organisation opens for sign-in; the keys of the checks that fail. */
  async readiness(ctx: TenantContext, plan: OnboardingPlan, administratorId: string): Promise<string[]> {
    const series: string[] = [];
    for (const key of plan.modules) series.push(...((await this.manifest(key)).setup?.receiptSeries ?? []).map((s) => s.key));
    const facts = await this.transactions.withTenant(ctx.tenantId, (tx) =>
      this.store.readiness(tx, {
        administratorRole: ADMINISTRATOR_ROLE.key,
        administratorId,
        modules: plan.modules.length > 0,
        series,
        fiscalYear: plan.financialYear.current,
      }),
    );
    const { tenant, profile, enabledModules, presentSeries } = facts;
    const failing: string[] = [];
    if (!tenant?.name || !tenant.legal_name) failing.push('identity');
    if (!profile?.email || !profile.address_line1 || !profile.city || !profile.postal_code || !profile.country || !profile.timezone) failing.push('profile');
    if (!facts.administratorRole?.includes('*')) failing.push('administratorRole');
    if (!facts.administrator) failing.push('administrator');
    if (enabledModules && plan.modules.some((m) => !enabledModules.includes(m))) failing.push('modules');
    if (presentSeries && presentSeries.length !== new Set(series).size) failing.push('receiptSeries');
    if (facts.fiscalYear !== 'open') failing.push('fiscalYear');
    return failing;
  }
}
