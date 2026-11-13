import { conflict, notFound, validationFailed } from '@onengo/kernel/errors';
import type { Logger } from '@onengo/kernel/ports';
import type { ConnectorHttp } from '../connectors/ports/connector-runtime.js';
import type { IdentityService } from '../identity/identity-service.js';
import type { OidcProviderInput, OidcService, OrganisationProviderView } from '../identity/oidc.js';
import type { AssuranceLevel, TenantAuthPolicy } from '../../domain/identity/ports/assurance.js';
import type { OperatorAuditActor, OrganisationLifecycle, OrganisationRow } from '../../domain/organisations/ports/organisation-directory.js';
import { SYSTEM_ACTOR_PREFIX } from '../../domain/system-actor.js';

/** The installation's shared provider as the console knows it: no client secret. */
export interface SharedProviderSummary {
  id: string;
  label: string;
  issuer: string;
  allowedDomains: string[];
}

export interface ProviderOptIn {
  enabled: boolean;
  assurance: AssuranceLevel;
  allowedDomains: string[];
  updatedAt: string | null;
}

export interface OrganisationSignIn {
  organisation: { code: string; displayName: string; status: string };
  policy: TenantAuthPolicy;
  /** Shared providers the organisation may opt into, with its opt-in. */
  shared: (SharedProviderSummary & { optIn: ProviderOptIn | null })[];
  /** The organisation's own providers. Secrets are never returned, only whether one is stored. */
  own: (OrganisationProviderView & { optIn: ProviderOptIn | null })[];
}

export interface ProviderCheck {
  ok: boolean;
  issuer: string;
  checks: { name: string; ok: boolean; message: string }[];
}

const ASSURANCE: readonly AssuranceLevel[] = ['aal1', 'aal2', 'aal3'];

function reasonOf(raw: string | undefined): string {
  const reason = raw?.trim() ?? '';
  if (!reason) throw validationFailed('Give the reason, which is kept in the audit.', [{ path: 'reason', message: 'Required.' }]);
  if (reason.length > 500) throw validationFailed('The reason is at most 500 characters.', [{ path: 'reason', message: 'At most 500 characters.' }]);
  return reason;
}

function assurance(value: unknown): AssuranceLevel {
  if (!ASSURANCE.includes(value as AssuranceLevel)) throw validationFailed('Assurance must be aal1, aal2 or aal3.');
  return value as AssuranceLevel;
}

const DISCOVERY_BYTES = 64 * 1024;
const JWKS_BYTES = 64 * 1024;

/**
 * An operator's view and changes of one organisation's sign-in: its policy, its opt-in to the installation's
 * shared provider, and its own OpenID Connect providers. Every change needs a reason, is written to the platform
 * audit and the organisation's audit, and never records a client secret.
 */
export class OrganisationSignInService {
  constructor(
    private readonly organisations: OrganisationLifecycle,
    private readonly identity: IdentityService,
    private readonly oidc: OidcService,
    private readonly shared: readonly SharedProviderSummary[],
    private readonly http: ConnectorHttp | undefined,
    private readonly logger: Logger,
  ) {}

  async view(code: string): Promise<OrganisationSignIn> {
    const org = await this.organisation(code);
    const [policy, optIns, own] = await Promise.all([
      this.identity.authPolicy(org.id),
      this.identity.providerPolicies(org.id),
      this.oidc.organisationProviders(org.id),
    ]);
    const optIn = (id: string): ProviderOptIn | null => {
      const p = optIns.find((o) => o.providerId === id);
      return p ? { enabled: p.enabled, assurance: p.assurance, allowedDomains: p.allowedDomains, updatedAt: p.updatedAt.toISOString() } : null;
    };
    return {
      organisation: { code: org.key, displayName: org.name, status: org.status },
      policy,
      shared: this.shared.filter((s) => !own.some((o) => o.id === s.id)).map((s) => ({ ...s, optIn: optIn(s.id) })),
      own: own.map((p) => ({ ...p, optIn: optIn(p.id) })),
    };
  }

  async savePolicy(
    operator: OperatorAuditActor,
    code: string,
    input: Omit<TenantAuthPolicy, 'passkeyEnabled'> & { passkeyEnabled?: boolean },
    reason?: string,
  ): Promise<OrganisationSignIn> {
    const why = reasonOf(reason);
    const org = await this.changeable(code);
    const before = await this.identity.authPolicy(org.id);
    // The console does not set passkeys; keep the organisation's own choice unless the input states one.
    const policy: TenantAuthPolicy = {
      passwordEnabled: input.passwordEnabled === true,
      emailCodeEnabled: input.emailCodeEnabled === true,
      passkeyEnabled: input.passkeyEnabled ?? before.passkeyEnabled,
      minimumAssurance: assurance(input.minimumAssurance),
    };
    await this.identity.applyAuthPolicy(org.id, policy, this.actorId(operator));
    await this.organisations.recordChange(org.id, operator, 'organisation.sign_in.policy_saved', { before, after: policy, reason: why });
    return this.view(org.key);
  }

  async setProviderPolicy(
    operator: OperatorAuditActor,
    code: string,
    providerId: string,
    input: { enabled: boolean; assurance: AssuranceLevel; allowedDomains?: string[] },
    reason?: string,
  ): Promise<OrganisationSignIn> {
    const why = reasonOf(reason);
    const org = await this.changeable(code);
    const known = this.shared.some((s) => s.id === providerId) || (await this.oidc.organisationProviders(org.id)).some((p) => p.id === providerId);
    if (!known) throw notFound('There is no such sign-in provider for this organisation.');
    const policy = { enabled: input.enabled === true, assurance: assurance(input.assurance), ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}) };
    await this.identity.applyProviderPolicy(org.id, providerId, policy, this.actorId(operator));
    const saved = await this.identity.providerPolicy(org.id, providerId);
    await this.organisations.recordChange(org.id, operator, 'organisation.sign_in.provider_policy_saved', { providerId, after: saved, reason: why });
    return this.view(org.key);
  }

  async saveProvider(operator: OperatorAuditActor, code: string, input: OidcProviderInput, reason?: string): Promise<OrganisationSignIn> {
    const why = reasonOf(reason);
    const org = await this.changeable(code);
    const existed = (await this.oidc.organisationProviders(org.id)).some((p) => p.id === input.id);
    await this.oidc.saveOrganisationProvider(org.id, input, this.actorId(operator));
    if (!existed && !(await this.identity.providerPolicy(org.id, input.id))) {
      await this.identity.applyProviderPolicy(org.id, input.id, { enabled: false, assurance: input.assurance ?? 'aal1' }, this.actorId(operator));
    }
    const { clientSecret: _secret, ...shown } = input;
    await this.organisations.recordChange(org.id, operator, 'organisation.sign_in.provider_saved', {
      provider: { ...shown, allowedDomains: shown.allowedDomains ?? [] },
      created: !existed,
      secretChanged: !!input.clientSecret?.trim(),
      reason: why,
    });
    return this.view(org.key);
  }

  async removeProvider(operator: OperatorAuditActor, code: string, providerId: string, reason?: string): Promise<OrganisationSignIn> {
    const why = reasonOf(reason);
    const org = await this.changeable(code);
    if (!(await this.oidc.removeOrganisationProvider(org.id, providerId, this.actorId(operator)))) {
      throw notFound('There is no such sign-in provider for this organisation.');
    }
    await this.organisations.recordChange(org.id, operator, 'organisation.sign_in.provider_removed', { providerId, reason: why });
    return this.view(org.key);
  }

  /** Reads the provider's discovery document and signing keys, as sign-in will. Changes nothing. */
  async testProvider(code: string, providerId: string): Promise<ProviderCheck> {
    const org = await this.organisation(code);
    const issuer =
      (await this.oidc.organisationProviders(org.id)).find((p) => p.id === providerId)?.issuer ?? this.shared.find((s) => s.id === providerId)?.issuer;
    if (!issuer) throw notFound('There is no such sign-in provider for this organisation.');
    return this.checkIssuer(issuer);
  }

  private async checkIssuer(issuer: string): Promise<ProviderCheck> {
    const checks: ProviderCheck['checks'] = [];
    const done = () => ({ ok: checks.every((c) => c.ok), issuer, checks });
    if (!this.http) {
      checks.push({ name: 'discovery', ok: false, message: 'This server cannot make outbound requests.' });
      return done();
    }
    let doc: Record<string, unknown>;
    try {
      const res = await this.http({ method: 'GET', url: `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, headers: { accept: 'application/json' }, maxBodyBytes: DISCOVERY_BYTES });
      if (res.status !== 200) throw new Error(`The provider answered ${res.status}.`);
      doc = JSON.parse(res.body) as Record<string, unknown>;
      checks.push({ name: 'discovery', ok: true, message: 'The discovery document was read.' });
    } catch (error) {
      this.logger.log('WARNING', 'sign-in provider check failed', { issuer, step: 'discovery' }, error);
      checks.push({ name: 'discovery', ok: false, message: `The discovery document could not be read: ${(error as Error).message}` });
      return done();
    }
    checks.push(
      doc.issuer === issuer
        ? { name: 'issuer', ok: true, message: 'The issuer matches.' }
        : { name: 'issuer', ok: false, message: `The provider calls itself '${String(doc.issuer)}', not '${issuer}'.` },
    );
    const endpoints = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const;
    const bad = endpoints.filter((k) => typeof doc[k] !== 'string' || !(doc[k] as string).startsWith('https://'));
    checks.push(
      bad.length
        ? { name: 'endpoints', ok: false, message: `Missing or not https: ${bad.join(', ')}.` }
        : { name: 'endpoints', ok: true, message: 'The sign-in endpoints are https addresses.' },
    );
    if (!bad.includes('jwks_uri')) {
      try {
        const res = await this.http({ method: 'GET', url: doc.jwks_uri as string, headers: { accept: 'application/json' }, maxBodyBytes: JWKS_BYTES });
        const keys = res.status === 200 ? (JSON.parse(res.body) as { keys?: unknown[] }).keys : undefined;
        checks.push(
          keys?.length
            ? { name: 'signing keys', ok: true, message: `${keys.length} signing key(s) published.` }
            : { name: 'signing keys', ok: false, message: `No signing keys were published (status ${res.status}).` },
        );
      } catch (error) {
        checks.push({ name: 'signing keys', ok: false, message: `The signing keys could not be read: ${(error as Error).message}` });
      }
    }
    return done();
  }

  private actorId(operator: OperatorAuditActor): string {
    return `${SYSTEM_ACTOR_PREFIX}operator:${operator.operatorId ?? operator.display}`;
  }

  private async organisation(code: string): Promise<OrganisationRow> {
    const org = await this.organisations.organisation(code.trim().toLowerCase());
    if (!org) throw notFound('There is no such organisation.');
    return org;
  }

  private async changeable(code: string): Promise<OrganisationRow> {
    const org = await this.organisation(code);
    if (org.status === 'closed') throw conflict('A closed organisation cannot be changed.');
    return org;
  }
}
