import type { AuditInput, AuditTrail } from '../../domain/ports/audit-trail.js';
import type { AccountRow, AccountStore, PasswordTokenInput, ProviderPolicy, SessionStore, SignInStore } from '../../domain/identity/ports/identity-directory.js';
import { emailDomains } from '../../domain/identity/email-domains.js';
import type { CredentialCrypto } from '@onengo/kernel/ports';
import type { TenantDirectory } from '../../domain/organisations/ports/organisation-directory.js';
import type { Actor, TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, notFound, PlatformError, validationFailed } from '@onengo/kernel/errors';
import { demand, demandGrant } from '../../domain/permissions.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import { PasswordPolicy } from '../../domain/identity/password-policy.js';
import { ROLES_PERMISSION } from '../../domain/identity/role-policy.js';
import type { MemberStore, SharedLimits } from '../../domain/identity/ports/member-store.js';
import type { RoleStore } from '../../domain/identity/ports/role-store.js';
import {
  type AssuranceLevel,
  type AuthenticationEvidence,
  type TenantAuthPolicy,
} from '../../domain/identity/ports/assurance.js';
import { assuranceAtLeast, withTotp } from '../../domain/identity/assurance.js';
import { SignInPipeline } from './sign-in/pipeline.js';

export interface IdentityConfig {
  tokenSecret: string;
  /** Password hashing, tokens, one-time codes and secrets at rest; previous keys in a ring still decrypt. */
  crypto: CredentialCrypto;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  maxFailures?: number;
  lockMinutes?: number;
  emailCodeTtlMinutes?: number;
  /** Sign-in codes allowed per address and per network address in 15 minutes. */
  codesPerEmail?: number;
  codesPerIp?: number;
  /** Delivers a one-time sign-in code. Wired to the notification engine. */
  deliverEmailCode?: (input: { tenantId: string; email: string; code: string }) => Promise<void>;
  /** Delivers a password reset or invitation link. Wired to the notification engine. */
  deliverPasswordLink?: (input: {
    tenantId: string;
    email: string;
    kind: 'reset' | 'invite';
    url: string;
    organisation: string;
    locale: string;
  }) => Promise<void>;
  /** The language of a member: their own choice, else the organisation's default. Wired to the locale store. */
  localeOf?: (tenantId: string, userId: string) => Promise<string>;
  /** Public address of the web app, e.g. https://ngo.example.org, used in emailed links. */
  publicBaseUrl?: string;
  /** Rules for new passwords. Defaults to length, common-password, pattern, and personal-detail checks without the online breach lookup. */
  passwordPolicy?: PasswordPolicy;
  /** How long a cached actor is trusted before the organisation's access version is re-checked. Default {@link ACCESS_CHECK_MS}. */
  accessCheckMs?: number;
  /** Queued when a member's name or email is written, so fields that follow the account can update. */
  userUpdated?: (tx: Tx, user: { userId: string; name: string; email: string }) => Promise<void>;
}

/** Records a member name or email change. Composition passes this in; it does not write the audit event itself. */
export function recordUserUpdated(audit: AuditTrail): NonNullable<IdentityConfig['userUpdated']> {
  return (tx, user) => audit.event(tx, 'user.updated', user);
}

/**
 * Longest time a role or membership change, or the end of a session, made on one
 * instance takes to reach requests on another: cached actors re-check
 * `tenant.access_version` and their session this often.
 */
export const ACCESS_CHECK_MS = 5_000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tenantId: string;
  userId: string;
  method: string;
  assurance: AuthenticationEvidence['assurance'];
  authTime: Date;
  amr: string[];
  acr?: string;
}

export interface RoleInput {
  key: string;
  label: string;
  permissions: string[];
  requireTwoStep?: boolean;
}

/** Fresh proof of identity for setting up two-step again while it is on. */
export interface TwoStepReauth {
  password?: string;
  totpCode?: string;
  ip?: string;
}

type SignInFlow = 'password' | 'emailCode';

/**
 * Why a sign-in was refused, named by a key the sign-in page knows. A provider
 * sign-in ends in a redirect, and the page shows its own wording for the key
 * rather than any text the address carries.
 */
export type SignInRefusal =
  | 'failed'
  | 'unavailable'
  | 'unfinished'
  | 'unreachable'
  | 'emailUnverified'
  | 'emailDomain'
  | 'notMember'
  | 'linkedElsewhere'
  | 'notAllowed';

export class AuthError extends PlatformError {
  constructor(
    message = 'Sign-in failed. Check your details and try again.',
    readonly refusal: SignInRefusal = 'failed',
  ) {
    super('forbidden', message);
    this.name = 'AuthError';
  }
}

/** The refusal key behind a thrown sign-in failure; anything unexpected is the generic one. */
export function signInRefusalOf(error: unknown): SignInRefusal {
  return error instanceof AuthError ? error.refusal : 'failed';
}

export class TwoStepRequired extends PlatformError {
  constructor() {
    super('forbidden', 'Enter the code from your authenticator app.');
    this.name = 'TwoStepRequired';
  }
}

const MIN_PASSWORD = 10;

export class IdentityService {
  private readonly actorCache = new Map<string, { actor: Actor; accessVersion: number; checkedAt: number }>();
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly passwords: PasswordPolicy;
  private readonly crypto: CredentialCrypto;
  private readonly pipeline: SignInPipeline<TokenPair>;

  constructor(
    private readonly transactions: TransactionManager,
    private readonly members: MemberStore,
    private readonly roles: Pick<RoleStore, 'save' | 'grants' | 'assign'>,
    private readonly limits: SharedLimits,
    private readonly tenants: TenantDirectory,
    private readonly accounts: AccountStore,
    private readonly signIn: SignInStore,
    private readonly sessions: SessionStore,
    private readonly config: IdentityConfig,
  ) {
    if (config.tokenSecret.length < 32) throw new Error('Token secret must be at least 32 characters.');
    this.crypto = config.crypto;
    this.accessTtl = config.accessTtlSeconds ?? 900;
    this.refreshTtl = config.refreshTtlSeconds ?? 30 * 24 * 3600;
    this.passwords = config.passwordPolicy ?? new PasswordPolicy({ minLength: MIN_PASSWORD });
    this.pipeline = new SignInPipeline(
      async (tenantId, userId) => {
        const account = await this.accounts.byId(userId);
        if (!account || account.status !== 'active' || !(await this.isActiveMember(tenantId, userId))) throw new AuthError();
        return { tenantId, account, policy: await this.signIn.authPolicy(tenantId) };
      },
      (resolved, evidence) => this.issue(resolved.account.id, resolved.tenantId, evidence),
    );
  }

  // -------------------------------------------------------- roles and members

  async upsertRole(ctx: TenantContext, role: RoleInput): Promise<void> {
    demand(ctx.actor, ROLES_PERMISSION);
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(role.key)) throw validationFailed('Role key must be lowercase letters, digits, - or _.');
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      await this.roles.save(tx, role.key, { label: role.label, permissions: role.permissions, requireTwoStep: role.requireTwoStep ?? false });
      await this.members.audit(tx, { actorId: ctx.actor.id, action: 'role.saved', entity: 'role', entityId: role.key, after: role });
    });
    this.actorCache.clear();
  }

  /**
   * Creates the person if needed, adds them to the NGO under the name typed here
   * (an existing account keeps the name other organisations gave it), and assigns
   * roles that allow no more than the actor's own. `alongside` runs in the same
   * transaction as the membership. Returns the user id.
   */
  async addMember(
    ctx: TenantContext,
    input: { email: string; displayName: string; roles: string[] },
    alongside?: (tx: Tx, userId: string) => Promise<void>,
  ): Promise<string> {
    demand(ctx.actor, 'members:manage');
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw validationFailed('Enter a valid email address.');
    const displayName = input.displayName.trim();
    const userId = await this.accounts.add(email, displayName);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      await this.members.join(tx, userId, displayName);
      for (const role of input.roles) await this.assign(tx, ctx.actor, userId, role);
      await this.members.audit(tx, {
        actorId: ctx.actor.id,
        action: 'member.added',
        entity: 'member',
        entityId: userId,
        after: { roles: input.roles },
      });
      await alongside?.(tx, userId);
      await this.config.userUpdated?.(tx, { userId, name: displayName, email });
    });
    this.actorCache.clear();
    return userId;
  }

  /** Signs the person out of the organisation on every device; access tokens stop working on the next request. */
  async endSessions(tenantId: string, userId: string): Promise<void> {
    await this.sessions.endForMember(tenantId, userId);
    this.actorCache.clear();
  }

  /** Ends sessions established by one method without affecting the member's other methods. */
  async endSessionsByMethod(tenantId: string, userId: string, method: string): Promise<void> {
    await this.sessions.endForMethod(tenantId, userId, method);
    this.actorCache.clear();
  }

  async authPolicy(tenantId: string): Promise<TenantAuthPolicy> {
    return this.signIn.authPolicy(tenantId);
  }

  async saveAuthPolicy(ctx: TenantContext, policy: TenantAuthPolicy): Promise<void> {
    demand(ctx.actor, 'auth:configure');
    await this.applyAuthPolicy(ctx.tenantId, policy, ctx.actor.id);
    await this.audit(ctx.tenantId, { actorId: ctx.actor.id, action: 'auth.policy_saved', entity: 'tenant', entityId: ctx.tenantId, after: policy });
  }

  /**
   * Saves the policy and ends the sessions of methods it switches off. The caller has checked who may do this
   * and records the audit. Switching passwords off keeps the two-protected-administrators rule.
   */
  async applyAuthPolicy(tenantId: string, policy: TenantAuthPolicy, updatedBy: string): Promise<void> {
    const outcome = await this.signIn.saveAuthPolicy(tenantId, policy, updatedBy);
    if (outcome !== 'saved') {
      throw validationFailed('Keep at least two active sign-in administrators protected by an enabled method before switching passwords off.');
    }
    if (!policy.passwordEnabled) await this.sessions.endForTenantMethod(tenantId, 'password');
    if (!policy.emailCodeEnabled) await this.sessions.endForTenantMethod(tenantId, 'email_code');
    if (!policy.passkeyEnabled) await this.sessions.endForTenantMethod(tenantId, 'passkey');
    this.actorCache.clear();
  }

  providerPolicy(tenantId: string, providerId: string): Promise<ProviderPolicy | undefined> {
    return this.signIn.providerPolicy(tenantId, providerId);
  }

  providerPolicies(tenantId: string): Promise<(ProviderPolicy & { providerId: string; updatedAt: Date })[]> {
    return this.signIn.providerPolicies(tenantId);
  }

  async enforceSignInPolicy(tenantId: string, evidence: AuthenticationEvidence): Promise<void> {
    this.pipeline.enforce(await this.signIn.authPolicy(tenantId), evidence);
  }

  async saveProviderPolicy(
    ctx: TenantContext,
    providerId: string,
    policy: { enabled: boolean; assurance: AssuranceLevel; allowedDomains?: string[] },
  ): Promise<void> {
    demand(ctx.actor, 'auth:configure');
    await this.applyProviderPolicy(ctx.tenantId, providerId, policy, ctx.actor.id);
    await this.audit(ctx.tenantId, {
      actorId: ctx.actor.id,
      action: 'auth.provider_policy_saved',
      entity: 'tenant',
      entityId: providerId,
      after: policy,
    });
  }

  /** Saves the opt-in and ends the provider's sessions when it is switched off. The caller checks access and audits. */
  async applyProviderPolicy(
    tenantId: string,
    providerId: string,
    policy: { enabled: boolean; assurance: AssuranceLevel; allowedDomains?: string[] },
    updatedBy: string,
  ): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(providerId)) throw validationFailed('Provider id must be lowercase letters, digits, or -.');
    const allowedDomains = policy.allowedDomains === undefined ? undefined : emailDomains(policy.allowedDomains);
    await this.signIn.saveProviderPolicy(tenantId, providerId, { ...policy, allowedDomains }, updatedBy);
    if (!policy.enabled) {
      await this.sessions.endForTenantMethod(tenantId, `oidc:${providerId}`);
      this.actorCache.clear();
    }
  }

  // ---------------------------------------------------------------- sign-in

  async setPassword(userId: string, password: string): Promise<void> {
    if (password.length < MIN_PASSWORD) throw validationFailed(`Use at least ${MIN_PASSWORD} characters.`);
    if (password.length > 200) throw validationFailed('Password is too long.');
    await this.passwords.check(password, await this.accounts.passwordContext(userId));
    await this.accounts.setPasswordHash(userId, await this.crypto.hashPassword(password));
  }

  async loginWithPassword(input: {
    tenantKey: string;
    email: string;
    password: string;
    totpCode?: string;
    ip?: string;
  }): Promise<TokenPair> {
    const email = input.email.trim().toLowerCase();
    await this.checkThrottle('password', email, input.ip);
    const user = await this.findUser(email);
    const ok = await this.crypto.verifyPassword(input.password, user?.password_hash ?? null);
    if (!ok || !user) {
      await this.recordFailure('password', email, input.ip);
      throw new AuthError();
    }
    return this.completeSignIn(user, input.tenantKey, input.totpCode, 'password', email, input.ip);
  }

  /** Always succeeds, so callers cannot learn which addresses are registered. */
  async requestEmailCode(input: { tenantKey: string; email: string; ip?: string }): Promise<void> {
    const email = input.email.trim().toLowerCase();
    const window = 15 * 60;
    if (!(await this.limits.hit(`code:email:${email}`, this.config.codesPerEmail ?? 3, window))) return;
    if (input.ip && !(await this.limits.hit(`code:ip:${input.ip}`, this.config.codesPerIp ?? 10, window))) return;
    const tenantId = await this.tenantIdForKey(input.tenantKey);
    if (!tenantId) return;
    if (!(await this.signIn.authPolicy(tenantId)).emailCodeEnabled) return;
    const user = await this.findUser(email);
    if (!user || user.status !== 'active' || !(await this.isActiveMember(tenantId, user.id))) return;
    const code = this.crypto.randomDigits(6);
    await this.signIn.addEmailCode(email, tenantId, this.crypto.sha256(code), this.config.emailCodeTtlMinutes ?? 10);
    await this.config.deliverEmailCode?.({ tenantId, email, code });
  }

  async loginWithEmailCode(input: { tenantKey: string; email: string; code: string; totpCode?: string; ip?: string }): Promise<TokenPair> {
    const email = input.email.trim().toLowerCase();
    await this.checkThrottle('emailCode', email, input.ip);
    const tenantId = await this.tenantIdForKey(input.tenantKey);
    const consumed = tenantId ? await this.signIn.useEmailCode(email, tenantId, this.crypto.sha256(input.code)) : false;
    const user = consumed ? await this.findUser(email) : undefined;
    if (!user) {
      await this.recordFailure('emailCode', email, input.ip);
      throw new AuthError();
    }
    return this.completeSignIn(user, input.tenantKey, input.totpCode, 'emailCode', email, input.ip);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const next = this.crypto.randomToken(32);
    const outcome = await this.sessions.rotate(this.crypto.sha256(refreshToken), this.crypto.sha256(next), this.refreshTtl);
    if ('refused' in outcome) throw new AuthError(outcome.refused === 'removed' ? 'Your access has been removed.' : 'Your session has ended. Sign in again.');
    if ('reusedFamily' in outcome) {
      // A rotated token was used again: treat the whole session as stolen. Committed before the error is raised.
      await this.sessions.endFamily(outcome.reusedFamily);
      this.actorCache.clear();
      throw new AuthError('Your session has ended. Sign in again.');
    }
    return this.pair(outcome.userId, outcome.tenantId, outcome.familyId, next, outcome.evidence);
  }

  /** Ends the session; its access tokens stop working on this instance at once and on others within {@link ACCESS_CHECK_MS}. */
  async logout(refreshToken: string): Promise<void> {
    await this.sessions.endByToken(this.crypto.sha256(refreshToken));
    this.actorCache.clear();
  }

  /** Resolves a bearer token to the signed-in person's NGO context while its session is live. */
  async authenticate(accessToken: string): Promise<TenantContext> {
    const claims = await this.crypto.verifyAccessToken(accessToken, this.config.tokenSecret);
    if (!claims) throw new AuthError('Your session has ended. Sign in again.');
    const cacheKey = `${claims.tid}|${claims.sub}|${claims.sid}`;
    const now = Date.now();
    const hit = this.actorCache.get(cacheKey);
    if (hit && now - hit.checkedAt < (this.config.accessCheckMs ?? ACCESS_CHECK_MS)) return { tenantId: claims.tid, actor: hit.actor };
    const loaded = await this.transactions.withTenant(claims.tid, async (tx) => {
      const accessVersion = await this.members.accessVersion(tx);
      if (accessVersion === undefined) return null;
      if (hit && hit.accessVersion === accessVersion) return { actor: hit.actor, accessVersion };
      const actor = await this.members.actor(tx, claims.sub);
      return actor && { actor, accessVersion };
    });
    if (!loaded) {
      this.actorCache.delete(cacheKey);
      throw new AuthError('Your access has been removed.');
    }
    if (typeof claims.sid !== 'string' || !(await this.sessions.isLive(claims.sid, claims.sub, claims.tid))) {
      this.actorCache.delete(cacheKey);
      throw new AuthError('Your session has ended. Sign in again.');
    }
    this.actorCache.set(cacheKey, { ...loaded, checkedAt: now });
    return { tenantId: claims.tid, actor: loaded.actor };
  }

  /** Makes role and membership changes take effect on this instance's next request; other instances follow within {@link ACCESS_CHECK_MS}. */
  forgetActors(): void {
    this.actorCache.clear();
  }

  /** Who is signed in and to which organisation, for the app header. */
  async profile(ctx: TenantContext): Promise<{
    userId: string;
    displayName: string;
    email: string | null;
    twoStepEnabled: boolean;
    tenant: { id: string; key: string; name: string };
  }> {
    const tenant = await this.transactions.withTenant(ctx.tenantId, (tx) => this.members.organisation(tx));
    if (!tenant) throw notFound('Unknown organisation.');
    const user = /^[0-9a-f-]{36}$/i.test(ctx.actor.id) ? await this.accounts.summary(ctx.actor.id) : undefined;
    return {
      userId: ctx.actor.id,
      displayName: user?.display_name ?? ctx.actor.id,
      email: user?.email ?? null,
      twoStepEnabled: user?.totp_enabled ?? false,
      tenant,
    };
  }

  // ---------------------------------------------------------------- two-step

  /**
   * Starts setting up an authenticator app. While two-step is on, the session alone is not enough:
   * the current password and a current code are required, and the enrolled app keeps working
   * until the new one is confirmed.
   */
  async beginTwoStep(ctx: TenantContext, reauth: TwoStepReauth = {}): Promise<{ secret: string; otpauthUrl: string }> {
    const user = /^[0-9a-f-]{36}$/i.test(ctx.actor.id) ? await this.accounts.byId(ctx.actor.id) : undefined;
    if (!user) throw notFound();
    if (user.totp_enabled) await this.reauthenticate(ctx.tenantId, user, reauth);
    const secret = this.crypto.generateTotpSecret();
    const email = await this.accounts.startTwoStep(user.id, this.crypto.encryptSecret(secret));
    if (email === undefined) throw notFound();
    await this.audit(ctx.tenantId, { actorId: user.id, action: 'two_step.setup_started', entity: 'member', entityId: user.id, after: { replacing: user.totp_enabled } });
    const label = encodeURIComponent(`NGO Platform:${email}`);
    return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=NGO%20Platform&digits=6&period=30` };
  }

  /** Switches two-step on with the app being set up, replacing an enrolled one. */
  async confirmTwoStep(ctx: TenantContext, code: string): Promise<void> {
    const pending = /^[0-9a-f-]{36}$/i.test(ctx.actor.id) ? await this.accounts.pendingTwoStepSecret(ctx.actor.id) : undefined;
    if (!pending || this.crypto.totpStep(this.crypto.decryptSecret(pending), code) === null) {
      throw validationFailed('That code is not correct.');
    }
    if (!(await this.accounts.confirmTwoStep(ctx.actor.id, pending))) {
      throw validationFailed('Two-step setup was started again meanwhile. Use the newest QR code.');
    }
    await this.audit(ctx.tenantId, { actorId: ctx.actor.id, action: 'two_step.enabled', entity: 'member', entityId: ctx.actor.id });
  }

  /**
   * Re-proves the signed-in person before a security-sensitive change such as
   * adding a passkey. Once two-step is on, that is the password and a current
   * authenticator code; before it is on, the live session is enough, as it is
   * for first-time two-step set-up.
   */
  async confirmReauthentication(ctx: TenantContext, reauth: TwoStepReauth = {}): Promise<void> {
    const user = /^[0-9a-f-]{36}$/i.test(ctx.actor.id) ? await this.accounts.byId(ctx.actor.id) : undefined;
    if (!user) throw notFound();
    if (user.totp_enabled) await this.reauthenticate(ctx.tenantId, user, reauth);
  }

  /** The organisation's id for its code, when it is active. */
  tenantIdFor(tenantKey: string): Promise<string | undefined> {
    return this.tenantIdForKey(tenantKey);
  }

  /** Writes an audit event for the organisation, in its own transaction. */
  recordAudit(tenantId: string, entry: AuditInput): Promise<void> {
    return this.audit(tenantId, entry);
  }

  /** Proves the person is at the keyboard: their password and a fresh authenticator code. Wrong answers count towards the account's lock. */
  private async reauthenticate(tenantId: string, user: AccountRow, reauth: TwoStepReauth): Promise<void> {
    if (!reauth.password || !reauth.totpCode) {
      throw validationFailed('Enter your current password and a code from your authenticator app to set up two-step again.');
    }
    const email = user.email.toLowerCase();
    if (await this.signIn.isLocked(this.throttleKeys('password', email, reauth.ip))) {
      throw validationFailed('Too many attempts. Try again in a few minutes.');
    }
    const passwordOk = await this.crypto.verifyPassword(reauth.password, user.password_hash);
    const step = passwordOk && user.totp_secret_enc ? this.crypto.totpStep(this.crypto.decryptSecret(user.totp_secret_enc), reauth.totpCode) : null;
    if (step === null || !(await this.accounts.useTwoStepStep(user.id, step))) {
      await this.recordFailure('password', email, reauth.ip);
      await this.audit(tenantId, { actorId: user.id, action: 'two_step.reauth_failed', entity: 'member', entityId: user.id });
      throw validationFailed('Your password or authenticator code is not correct.');
    }
  }

  // --------------------------------------------------------------- internals

  private async assign(tx: Tx, actor: Actor, userId: string, roleKey: string): Promise<void> {
    const role = (await this.roles.grants(tx)).find((g) => g.key === roleKey);
    if (!role) throw validationFailed(`Role '${roleKey}' does not exist.`);
    demandGrant(actor, [role]);
    await this.roles.assign(tx, userId, roleKey, actor.id);
  }

  private audit(tenantId: string, entry: AuditInput): Promise<void> {
    return this.transactions.withTenant(tenantId, (tx) => this.members.audit(tx, entry));
  }

  // --------------------------------------------- reset and invitations

  /** Always succeeds, so callers cannot learn which addresses are registered. */
  async requestPasswordReset(input: { tenantKey: string; email: string; ip?: string }): Promise<void> {
    const email = input.email.trim().toLowerCase();
    if (!(await this.limits.hit(`reset:email:${email}`, 3, 15 * 60))) return;
    if (input.ip && !(await this.limits.hit(`reset:ip:${input.ip}`, 10, 15 * 60))) return;
    const tenantId = await this.tenantIdForKey(input.tenantKey);
    if (!tenantId) return;
    const user = await this.findUser(email);
    if (!user || user.status !== 'active' || !(await this.isActiveMember(tenantId, user.id))) return;
    const token = await this.createToken(user.id, tenantId, 'reset', 30, null);
    await this.sendLink(tenantId, user.id, user.email, 'reset', token);
  }

  /** Emails a member a link to set their password. Earlier unused invitations stop working. */
  async inviteMember(ctx: TenantContext, userId: string): Promise<void> {
    demand(ctx.actor, 'members:manage');
    if (!(await this.isActiveMember(ctx.tenantId, userId))) throw notFound('This person is not a member of the organisation.');
    const email = await this.accounts.activeEmail(userId);
    if (email === undefined) throw notFound('This person is not a member of the organisation.');
    const token = await this.createToken(userId, ctx.tenantId, 'invite', 7 * 24 * 60, ctx.actor.id);
    await this.audit(ctx.tenantId, { actorId: ctx.actor.id, action: 'member.invited', entity: 'member', entityId: userId });
    await this.sendLink(ctx.tenantId, userId, email, 'invite', token);
  }

  /** Whether a reset or invitation link still works, so the page can say so before asking for a password. Reads only: the link is not spent. */
  async passwordTokenUsable(token: string): Promise<boolean> {
    return !!(await this.signIn.openPasswordToken(this.crypto.sha256(token)));
  }

  /** Sets a new password from a reset or invitation link, then ends every existing session for that person. */
  async completePasswordToken(input: { token: string; password: string }): Promise<{ tenantKey: string }> {
    const row = await this.signIn.openPasswordToken(this.crypto.sha256(input.token));
    if (!row) throw new AuthError('This link has expired or has already been used. Ask for a new one.');
    await this.setPassword(row.user_id, input.password);
    await this.signIn.finishPasswordTokens(row.user_id);
    this.actorCache.clear();
    const account = await this.accounts.byId(row.user_id);
    if (account) await this.clearThrottle(account.email.toLowerCase());
    await this.audit(row.tenant_id, { actorId: row.user_id, action: row.purpose === 'invite' ? 'password.set' : 'password.reset', entity: 'member', entityId: row.user_id });
    return { tenantKey: row.key };
  }

  // ------------------------------------------- sign-in by trusted provider

  /**
   * Completes sign-in for a person already verified by a sign-in provider.
   * Roles that require two-step still get a short-lived ticket instead of a session.
   */
  async signInVerifiedUser(input: { tenantId: string; userId: string; method: string; evidence?: AuthenticationEvidence }): Promise<
    { kind: 'tokens'; pair: TokenPair } | { kind: 'twoStep'; ticket: string }
  > {
    const evidence: AuthenticationEvidence =
      input.evidence ?? { method: input.method, assurance: 'aal1', authTime: new Date(), amr: [input.method] };
    const user = await this.accounts.byId(input.userId);
    if (!user || user.status !== 'active' || !(await this.isActiveMember(input.tenantId, user.id))) throw new AuthError();
    const policy = await this.signIn.authPolicy(input.tenantId);
    const needsTwoStep =
      user.totp_enabled ||
      (await this.rolesRequireTwoStep(input.tenantId, user.id)) ||
      !assuranceAtLeast(evidence.assurance, policy.minimumAssurance);
    if (needsTwoStep) {
      if (!user.totp_enabled) {
        throw new PlatformError('forbidden', 'Your role requires two-step sign-in. Ask an administrator to help you set it up.');
      }
      const ticket = await this.createToken(user.id, input.tenantId, 'two_step', 5, null, evidence);
      return { kind: 'twoStep', ticket };
    }
    const pair = await this.pipeline.complete({ tenantId: input.tenantId, userId: user.id, evidence });
    await this.audit(input.tenantId, { actorId: user.id, action: 'signed_in', entity: 'member', entityId: user.id, after: { method: input.method } });
    return { kind: 'tokens', pair };
  }

  async completeTwoStepTicket(input: { ticket: string; totpCode: string }): Promise<TokenPair> {
    const outcome = await this.signIn.useTwoStepTicket(this.crypto.sha256(input.ticket), (secretEnc) =>
      this.crypto.totpStep(this.crypto.decryptSecret(secretEnc), input.totpCode),
    );
    if (!outcome || !(await this.isActiveMember(outcome.tenantId, outcome.userId))) throw new AuthError();
    const source = outcome.evidence ?? {
      method: 'provider',
      assurance: 'aal1' as const,
      authTime: new Date(),
      amr: ['provider'],
    };
    const evidence = { ...source, assurance: withTotp(source.assurance), amr: [...new Set([...source.amr, 'otp'])] };
    const pair = await this.pipeline.complete({ tenantId: outcome.tenantId, userId: outcome.userId, evidence });
    await this.audit(outcome.tenantId, { actorId: outcome.userId, action: 'signed_in', entity: 'member', entityId: outcome.userId, after: { method: 'provider+two_step' } });
    return pair;
  }

  private async createToken(
    userId: string,
    tenantId: string,
    purpose: PasswordTokenInput['purpose'],
    ttlMinutes: number,
    createdBy: string | null,
    evidence?: AuthenticationEvidence,
  ): Promise<string> {
    const token = this.crypto.randomToken(32);
    await this.signIn.addPasswordToken({ userId, tenantId, purpose, tokenHash: this.crypto.sha256(token), ttlMinutes, createdBy, evidence });
    return token;
  }

  /** The link carries the language too, so the set-password page opens in it before there is a session. */
  private async sendLink(tenantId: string, userId: string, email: string, kind: 'reset' | 'invite', token: string): Promise<void> {
    const tenant = await this.tenants.keyAndName(tenantId);
    const locale = (await this.config.localeOf?.(tenantId, userId)) ?? 'en';
    const base = (this.config.publicBaseUrl ?? '').replace(/\/+$/, '');
    const query = new URLSearchParams({ token, org: tenant!.key, kind });
    if (locale !== 'en') query.set('lang', locale);
    await this.config.deliverPasswordLink?.({ tenantId, email, kind, url: `${base}/reset-password?${query}`, organisation: tenant!.name, locale });
  }

  private async completeSignIn(
    user: AccountRow,
    tenantKey: string,
    totpCode: string | undefined,
    flow: SignInFlow,
    email: string,
    ip?: string,
  ): Promise<TokenPair> {
    const tenantId = await this.tenantIdForKey(tenantKey);
    if (!tenantId || user.status !== 'active' || !(await this.isActiveMember(tenantId, user.id))) {
      await this.recordFailure(flow, email, ip);
      throw new AuthError();
    }
    const policy = await this.signIn.authPolicy(tenantId);
    const baseEvidence: AuthenticationEvidence = {
      method: flow === 'emailCode' ? 'email_code' : 'password',
      assurance: 'aal1',
      authTime: new Date(),
      amr: [flow === 'emailCode' ? 'email' : 'pwd'],
    };
    if (flow === 'password' && !policy.passwordEnabled) {
      throw new PlatformError('forbidden', 'Password sign-in is not available for this organisation.');
    }
    if (flow === 'emailCode' && !policy.emailCodeEnabled) {
      throw new PlatformError('forbidden', 'Email-code sign-in is not available for this organisation.');
    }
    const needsTwoStep =
      user.totp_enabled ||
      (await this.rolesRequireTwoStep(tenantId, user.id)) ||
      !assuranceAtLeast(baseEvidence.assurance, policy.minimumAssurance);
    let evidence = baseEvidence;
    if (needsTwoStep) {
      if (!user.totp_enabled || !user.totp_secret_enc) {
        throw new PlatformError('forbidden', 'Your role requires two-step sign-in. Ask an administrator to help you set it up.');
      }
      if (!totpCode) throw new TwoStepRequired();
      const step = this.crypto.totpStep(this.crypto.decryptSecret(user.totp_secret_enc), totpCode);
      if (step === null || !(await this.accounts.useTwoStepStep(user.id, step))) {
        await this.recordFailure(flow, email, ip);
        throw new AuthError();
      }
      evidence = { ...baseEvidence, assurance: withTotp(baseEvidence.assurance), amr: [...baseEvidence.amr, 'otp'] };
    }
    await this.clearThrottle(email);
    const pair = await this.pipeline.complete({ tenantId, userId: user.id, evidence });
    await this.audit(tenantId, { actorId: user.id, action: 'signed_in', entity: 'member', entityId: user.id });
    return pair;
  }

  private async issue(userId: string, tenantId: string, evidence: AuthenticationEvidence): Promise<TokenPair> {
    const refreshToken = this.crypto.randomToken(32);
    const familyId = await this.sessions.start(userId, tenantId, this.crypto.sha256(refreshToken), this.refreshTtl, evidence);
    return this.pair(userId, tenantId, familyId, refreshToken, evidence);
  }

  private async pair(
    userId: string,
    tenantId: string,
    familyId: string,
    refreshToken: string,
    evidence: AuthenticationEvidence,
  ): Promise<TokenPair> {
    const accessToken = await this.crypto.signAccessToken(
      {
        sub: userId,
        tid: tenantId,
        sid: familyId,
        typ: 'access',
        method: evidence.method,
        assurance: evidence.assurance,
        auth_time: Math.floor(evidence.authTime.getTime() / 1000),
        amr: evidence.amr,
        acr: evidence.acr,
      },
      this.config.tokenSecret,
      this.accessTtl,
    );
    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtl,
      tenantId,
      userId,
      method: evidence.method,
      assurance: evidence.assurance,
      authTime: evidence.authTime,
      amr: evidence.amr,
      ...(evidence.acr ? { acr: evidence.acr } : {}),
    };
  }

  private findUser(email: string): Promise<AccountRow | undefined> {
    return this.accounts.byEmail(email);
  }

  private tenantIdForKey(key: string): Promise<string | undefined> {
    return this.tenants.activeIdByKey(key);
  }

  private isActiveMember(tenantId: string, userId: string): Promise<boolean> {
    return this.accounts.isActiveMember(tenantId, userId);
  }

  private rolesRequireTwoStep(tenantId: string, userId: string): Promise<boolean> {
    return this.accounts.rolesRequireTwoStep(tenantId, userId);
  }

  /**
   * Password guesses and emailed-code guesses lock the account separately, so a stranger who
   * locks password sign-in cannot stop the holder signing in with a code sent to their mailbox;
   * that sign-in, or a password reset, clears both locks.
   */
  private throttleKeys(flow: SignInFlow, email: string, ip?: string): string[] {
    return [flow === 'password' ? `email:${email}` : `email-code:${email}`, ...(ip ? [`ip:${ip}`] : [])];
  }

  private async checkThrottle(flow: SignInFlow, email: string, ip?: string): Promise<void> {
    if (await this.signIn.isLocked(this.throttleKeys(flow, email, ip))) {
      throw forbidden(
        flow === 'password'
          ? 'Too many attempts. Try again in a few minutes, sign in with a code sent to your email, or reset your password.'
          : 'Too many attempts. Try again in a few minutes, or reset your password.',
      );
    }
  }

  private async recordFailure(flow: SignInFlow, email: string, ip?: string): Promise<void> {
    const max = this.config.maxFailures ?? 5;
    await this.signIn.recordFailures(
      this.throttleKeys(flow, email, ip).map((key) => ({
        key,
        // The IP limit is looser than the account limit so shared office networks are not locked out.
        limit: key.startsWith('ip:') ? max * 4 : max,
      })),
      this.config.lockMinutes ?? 15,
    );
  }

  /** Clears the account counters only; the IP counter keeps limiting spraying across accounts. */
  private async clearThrottle(email: string): Promise<void> {
    await this.signIn.clearFailures(`email:${email}`);
    await this.signIn.clearFailures(`email-code:${email}`);
  }
}
