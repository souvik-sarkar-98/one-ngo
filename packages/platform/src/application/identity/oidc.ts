import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { pkceChallenge, safeNextPath } from '@onengo/kernel/oidc';
export { safeNextPath } from '@onengo/kernel/oidc';
import type { CredentialCrypto } from '@onengo/kernel/ports';
import type { SystemIdentity } from '../../domain/identity/ports/identity-directory.js';
import type { TenantDirectory } from '../../domain/organisations/ports/organisation-directory.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { validationFailed } from '@onengo/kernel/errors';
import { demand } from '../../domain/permissions.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import { AuthError, type IdentityService, type TokenPair } from './identity-service.js';
import type { OidcStore } from '../../domain/identity/ports/oidc-store.js';
import type { AssuranceLevel } from '../../domain/identity/ports/assurance.js';
import { emailDomainAllowed, emailDomains } from '../../domain/identity/email-domains.js';

export interface OidcProviderConfig {
  /** Short id used in URLs, e.g. "google". */
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Only accept these email domains, e.g. ["asha.org"]. Empty allows any verified email. */
  allowedDomains?: string[];
  /** Assurance assigned by the NGO when saving its own provider. */
  assurance?: AssuranceLevel;
}

/** An own provider as saved: the client secret may be left out to keep the stored one. */
export type OidcProviderInput = Omit<OidcProviderConfig, 'clientSecret'> & { clientSecret?: string };

export interface OrganisationProviderView {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  allowedDomains: string[];
  secretSet: boolean;
  updatedAt: string;
}

export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface OidcOptions {
  publicBaseUrl: string;
  crypto: CredentialCrypto;
  /** Providers available to every NGO on this installation, e.g. Google from environment settings. */
  installationProviders?: OidcProviderConfig[];
  fetch?: HttpFetch;
}

export type OidcResult =
  | { kind: 'tokens'; pair: TokenPair; next: string }
  | { kind: 'twoStep'; ticket: string; next: string };

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const GOOGLE = 'https://accounts.google.com';
const CACHE_MS = 60 * 60 * 1000;
const SKEW_S = 60;

/**
 * OpenID Connect sign-in (authorization code flow with PKCE). A provider
 * account signs in only a person who is already an active member of the NGO,
 * matched by verified email on first use and by provider subject afterwards.
 */
export class OidcService {
  private readonly discoveryCache = new Map<string, { at: number; doc: Discovery }>();
  private readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  private readonly http: HttpFetch;

  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: OidcStore,
    private readonly tenants: TenantDirectory,
    private readonly system: SystemIdentity,
    private readonly identity: IdentityService,
    private readonly options: OidcOptions,
  ) {
    this.http =
      options.fetch ??
      (async (url, init) => {
        const res = await fetch(url, init);
        return { status: res.status, json: () => res.json() };
      });
  }

  get redirectUri(): string {
    return `${this.options.publicBaseUrl.replace(/\/+$/, '')}/api/auth/oidc/callback`;
  }

  /** Providers shown on the sign-in page for an organisation. Reveals labels only. */
  async providersFor(tenantKey: string): Promise<{ id: string; label: string }[]> {
    const tenantId = await this.tenantId(tenantKey);
    if (!tenantId) return [];
    return (await this.configs(tenantId)).map((p) => ({ id: p.id, label: p.label }));
  }

  /** Saves an NGO's own provider (e.g. their Google Workspace or Microsoft tenant). */
  async saveTenantProvider(ctx: TenantContext, p: OidcProviderConfig): Promise<void> {
    demand(ctx.actor, 'auth:configure');
    await this.saveOrganisationProvider(ctx.tenantId, p, ctx.actor.id);
    await this.identity.saveProviderPolicy(ctx, p.id, { enabled: true, assurance: p.assurance ?? 'aal1' });
  }

  /** The organisation's own providers. Client secrets are never returned, only whether one is stored. */
  async organisationProviders(tenantId: string): Promise<OrganisationProviderView[]> {
    const rows = await this.transactions.withTenant(tenantId, (tx) => this.store.providerDetails(tx));
    return rows.map((r) => {
      const c = r.config as Partial<OidcProviderConfig>;
      return {
        id: c.id ?? r.key.replace(/^oidc:/, ''),
        label: c.label ?? '',
        issuer: c.issuer ?? '',
        clientId: c.clientId ?? '',
        allowedDomains: c.allowedDomains ?? [],
        secretSet: !!r.secret_enc,
        updatedAt: r.updated_at.toISOString(),
      };
    });
  }

  /**
   * Creates or replaces one of the organisation's own providers. Without `clientSecret` the stored secret is
   * kept, so a change of label or domains does not need it again. The caller checks access; this records the
   * organisation's own audit entry as `updatedBy`.
   */
  async saveOrganisationProvider(tenantId: string, p: OidcProviderInput, updatedBy: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(p.id)) throw validationFailed('Provider id must be lowercase letters, digits, or -.');
    if (!p.label?.trim() || p.label.trim().length > 60) throw validationFailed('Give the provider a label of at most 60 characters.');
    if (!/^https:\/\/[^\s/]+/.test(p.issuer)) throw validationFailed('Issuer must be an https address.');
    if (!p.clientId?.trim()) throw validationFailed('Give the client id the provider issued.');
    // An NGO-run provider decides which emails it vouches for, so limit it to the NGO's own domains.
    const allowedDomains = emailDomains(p.allowedDomains ?? []);
    if (!allowedDomains.length) throw validationFailed('List the email domains this provider may sign in, e.g. asha.org.');
    const key = `oidc:${p.id}`;
    const config = { id: p.id, label: p.label.trim(), issuer: p.issuer.trim(), clientId: p.clientId.trim(), allowedDomains, ...(p.assurance ? { assurance: p.assurance } : {}) };
    await this.transactions.withTenant(tenantId, async (tx) => {
      const secret = p.clientSecret?.trim();
      const secretEnc = secret
        ? this.options.crypto.encryptSecret(secret)
        : (await this.store.providerDetails(tx)).find((r) => r.key === key)?.secret_enc;
      if (!secretEnc) throw validationFailed('Give the client secret the provider issued.');
      await this.store.saveProvider(tx, { key, config: JSON.stringify(config), secretEnc, updatedBy });
      await this.store.audit(tx, { actorId: updatedBy, action: 'connector.saved', entity: 'connector', entityId: key, after: { ...config, secretChanged: !!secret } });
    });
  }

  /** Switches the organisation's own provider off and forgets its secret; its sessions end. */
  async removeOrganisationProvider(tenantId: string, providerId: string, updatedBy: string): Promise<boolean> {
    const key = `oidc:${providerId}`;
    const removed = await this.transactions.withTenant(tenantId, async (tx) => {
      const done = await this.store.removeProvider(tx, key, updatedBy);
      if (done) await this.store.audit(tx, { actorId: updatedBy, action: 'connector.removed', entity: 'connector', entityId: key });
      return done;
    });
    if (removed) {
      const policy = await this.identity.providerPolicy(tenantId, providerId);
      await this.identity.applyProviderPolicy(tenantId, providerId, { enabled: false, assurance: policy?.assurance ?? 'aal1' }, updatedBy);
    }
    return removed;
  }

  /** The installation's shared providers, without their secrets. */
  installationProviderSummaries(): { id: string; label: string; issuer: string; allowedDomains: string[] }[] {
    return (this.options.installationProviders ?? []).map((p) => ({ id: p.id, label: p.label, issuer: p.issuer, allowedDomains: p.allowedDomains ?? [] }));
  }

  /** Explicitly opts an NGO into or out of an installation provider. */
  saveProviderPolicy(ctx: TenantContext, providerId: string, policy: { enabled: boolean; assurance: AssuranceLevel }): Promise<void> {
    return this.identity.saveProviderPolicy(ctx, providerId, policy);
  }

  /** Returns the provider address to send the browser to. */
  async start(tenantKey: string, providerId: string, next?: string): Promise<string> {
    const tenantId = await this.tenantId(tenantKey);
    const cfg = tenantId ? (await this.configs(tenantId)).find((p) => p.id === providerId) : undefined;
    if (!tenantId || !cfg) throw new AuthError('This sign-in option is not available for the organisation.', 'unavailable');
    const doc = await this.discovery(cfg.issuer);
    const state = this.options.crypto.randomToken(32);
    const nonce = this.options.crypto.randomToken(24);
    const verifier = this.options.crypto.randomToken(48);
    await this.system.startOidcLogin({
      state_hash: this.options.crypto.sha256(state),
      tenant_id: tenantId,
      provider: cfg.id,
      nonce,
      code_verifier: verifier,
      next_path: safeNextPath(next),
    });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: this.redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `${doc.authorization_endpoint}?${params}`;
  }

  async callback(query: { code?: string; state?: string; error?: string }): Promise<OidcResult> {
    const { code, state } = query;
    if (query.error || !code || !state) throw new AuthError('Sign-in was cancelled or failed. Try again.', 'unfinished');
    const login = await this.system.useOidcLogin(this.options.crypto.sha256(state));
    if (!login) throw new AuthError('This sign-in attempt has expired. Start again.', 'unfinished');
    const cfg = (await this.configs(login.tenant_id)).find((p) => p.id === login.provider);
    if (!cfg) throw new AuthError('This sign-in option is no longer available.', 'unavailable');
    const doc = await this.discovery(cfg.issuer);

    const tokenRes = await this.http(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code_verifier: login.code_verifier,
      }).toString(),
    });
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (tokenRes.status >= 300 || !tokens.id_token) throw new AuthError('The sign-in provider did not confirm your identity.');

    const claims = await this.verifyIdToken(tokens.id_token, cfg, doc, login.nonce);
    const evidence = {
      method: `oidc:${cfg.id}`,
      assurance: cfg.assurance,
      authTime: claims.authTime,
      amr: claims.amr.length ? claims.amr : ['federated'],
      ...(claims.acr ? { acr: claims.acr } : {}),
      providerIssuer: claims.iss,
      ...(claims.sid ? { providerSid: claims.sid } : {}),
    };
    // Refuse policy downgrades before first-use linking, so refusal has no identity side effect.
    try {
      await this.identity.enforceSignInPolicy(login.tenant_id, evidence);
    } catch (e) {
      throw e instanceof AuthError ? e : new AuthError(e instanceof Error ? e.message : undefined, 'notAllowed');
    }
    const userId = await this.resolveMember(login.tenant_id, claims);
    const result = await this.identity.signInVerifiedUser({
      tenantId: login.tenant_id,
      userId,
      method: `oidc:${cfg.id}`,
      evidence,
    });
    return result.kind === 'tokens'
      ? { kind: 'tokens', pair: result.pair, next: safeNextPath(login.next_path) }
      : { kind: 'twoStep', ticket: result.ticket, next: safeNextPath(login.next_path) };
  }

  /** Checks signature, issuer, audience, time, nonce, and verified email. */
  async verifyIdToken(
    idToken: string,
    cfg: OidcProviderConfig & { organisationDomains?: string[] },
    doc: Discovery,
    nonce: string,
  ): Promise<{ sub: string; email: string; iss: string; authTime: Date; amr: string[]; acr?: string; sid?: string }> {
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(idToken, this.keys(doc.jwks_uri), {
        algorithms: ['RS256', 'ES256'],
        issuer: cfg.issuer === GOOGLE ? [GOOGLE, 'accounts.google.com'] : cfg.issuer,
        audience: cfg.clientId,
        clockTolerance: SKEW_S,
        requiredClaims: ['exp', 'iat'],
      }));
    } catch (e) {
      throw e instanceof AuthError ? e : new AuthError();
    }
    const aud = claims.aud;
    const azpOk = !Array.isArray(aud) || aud.length === 1 || claims.azp === cfg.clientId;
    const iatOk = Number(claims.iat) < Math.floor(Date.now() / 1000) + SKEW_S;
    if (!azpOk || !iatOk || claims.nonce !== nonce) throw new AuthError();

    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    if (!email || !verified || typeof claims.sub !== 'string' || !claims.sub) {
      throw new AuthError('Your sign-in provider has not verified your email address.', 'emailUnverified');
    }
    if (!emailDomainAllowed(email, (cfg.allowedDomains ?? []).map((d) => d.toLowerCase()), cfg.organisationDomains)) {
      throw new AuthError('Use your organisation email address to sign in.', 'emailDomain');
    }
    const authSeconds = typeof claims.auth_time === 'number' ? claims.auth_time : Number(claims.iat);
    return {
      sub: claims.sub,
      email,
      iss: cfg.issuer,
      authTime: new Date(authSeconds * 1000),
      amr: Array.isArray(claims.amr) ? claims.amr.filter((v): v is string => typeof v === 'string') : [],
      ...(typeof claims.acr === 'string' ? { acr: claims.acr } : {}),
      ...(typeof claims.sid === 'string' ? { sid: claims.sid } : {}),
    };
  }

  private async resolveMember(tenantId: string, c: { sub: string; email: string; iss: string }): Promise<string> {
    const found = await this.system.oidcMember(tenantId, c);
    if ('userId' in found) return found.userId;
    throw found.refused === 'linked-elsewhere'
      ? new AuthError('This person is already linked to a different account at this provider.', 'linkedElsewhere')
      : new AuthError('No member with this email address belongs to the organisation.', 'notMember');
  }

  private async configs(tenantId: string): Promise<(OidcProviderConfig & { assurance: AssuranceLevel; organisationDomains: string[] })[]> {
    const rows = await this.transactions.withTenant(tenantId, (tx) => this.store.providers(tx));
    const own = rows
      .map((r) => ({ secret_enc: r.secret_enc, config: r.config as unknown as Omit<OidcProviderConfig, 'clientSecret'> }))
      .filter((r) => r.secret_enc && r.config.allowedDomains?.length)
      .map((r) => ({ ...r.config, clientSecret: this.options.crypto.decryptSecret(r.secret_enc!), assurance: r.config.assurance ?? ('aal1' as const) }));
    const installation = (this.options.installationProviders ?? []).filter((p) => !own.some((o) => o.id === p.id));
    const candidates = [...own, ...installation];
    const policies = await Promise.all(candidates.map((p) => this.identity.providerPolicy(tenantId, p.id)));
    return candidates.flatMap((provider, index) => {
      const policy = policies[index];
      return policy?.enabled ? [{ ...provider, assurance: policy.assurance, organisationDomains: policy.allowedDomains }] : [];
    });
  }

  private async discovery(issuer: string): Promise<Discovery> {
    const hit = this.discoveryCache.get(issuer);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.doc;
    const res = await this.http(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
    const doc = (await res.json()) as Partial<Discovery>;
    if (res.status >= 300 || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new AuthError('The sign-in provider is not reachable right now.', 'unreachable');
    }
    for (const u of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) {
      if (!u.startsWith('https://')) throw new AuthError('The sign-in provider is misconfigured.', 'unavailable');
    }
    const value = doc as Discovery;
    this.discoveryCache.set(issuer, { at: Date.now(), doc: value });
    return value;
  }

  /**
   * The provider's signing keys, cached for an hour. An unknown key id fetches
   * the set again at once (no cool-down), since the provider may have rotated keys.
   */
  private keys(jwksUri: string): JWTVerifyGetKey {
    let remote = this.jwksCache.get(jwksUri);
    if (!remote) {
      remote = createRemoteJWKSet(new URL(jwksUri), {
        cacheMaxAge: CACHE_MS,
        cooldownDuration: 0,
        [customFetch]: async (url: string, init: RequestInit) => {
          const res = await this.http(url, { method: 'GET', headers: Object.fromEntries(new Headers(init.headers)) });
          return { status: res.status, json: () => res.json() } as Response;
        },
      });
      this.jwksCache.set(jwksUri, remote);
    }
    const jwks = remote;
    return async (header, token) => {
      if (!header.kid) throw new AuthError();
      try {
        return await jwks(header, token);
      } catch (e) {
        if (e instanceof errors.JWKSNoMatchingKey || e instanceof errors.JWKSMultipleMatchingKeys) throw new AuthError();
        throw new AuthError('The sign-in provider is not reachable right now.', 'unreachable');
      }
    };
  }

  private tenantId(key: string): Promise<string | undefined> {
    return this.tenants.activeIdByKey(key);
  }
}
