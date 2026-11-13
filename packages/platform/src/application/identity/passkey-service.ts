import { forbidden, notFound, validationFailed } from '@onengo/kernel/errors';
import type { AccountStore } from '../../domain/identity/ports/identity-directory.js';
import type { AuthenticationEvidence } from '../../domain/identity/ports/assurance.js';
import type { SharedLimits } from '../../domain/identity/ports/member-store.js';
import type { PasskeyCredentialRow, PasskeyStore } from '../../domain/identity/ports/passkey-store.js';
import type { PasskeyRelyingParty, VerifiedAssertion, WebAuthnCeremonies } from '../../domain/identity/ports/webauthn-ceremonies.js';
import { PASSKEY_ASSURANCE } from '../../domain/identity/assurance.js';
import {
  counterAccepted,
  MAX_PASSKEYS_PER_PERSON,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASSKEY_LIMIT,
  passkeyName,
} from '../../domain/identity/passkey.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { AuthError, type IdentityService, type TokenPair, type TwoStepReauth } from './identity-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PasskeySignInOutcome = { kind: 'tokens'; pair: TokenPair } | { kind: 'twoStep'; ticket: string };

/** A passkey as the person manages it: never the key or counter. */
export interface PasskeySummary {
  id: string;
  name: string;
  deviceType: 'multiDevice' | 'singleDevice';
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Passkeys as a sign-in method and as the person's device credentials. A
 * passkey proves possession of a device plus a local user verification, so a
 * verified sign-in is AAL2. Every sign-in goes through the same pipeline as
 * password and email-code sign-in, so policy, two-step rules and session
 * revocation apply unchanged.
 */
export class PasskeyService {
  constructor(
    private readonly identity: Pick<
      IdentityService,
      'confirmReauthentication' | 'tenantIdFor' | 'recordAudit' | 'signInVerifiedUser' | 'authPolicy' | 'endSessionsByMethod'
    >,
    private readonly store: PasskeyStore,
    private readonly accounts: Pick<AccountStore, 'summary'>,
    private readonly limits: SharedLimits,
    private readonly ceremonies: WebAuthnCeremonies,
    private readonly relyingParty: PasskeyRelyingParty,
  ) {}

  /** Whether the organisation's sign-in page offers passkeys. Answers the same for unknown organisations. */
  async available(tenantKey: string): Promise<boolean> {
    const tenantId = await this.identity.tenantIdFor(tenantKey);
    if (!tenantId) return false;
    return (await this.identity.authPolicy(tenantId)).passkeyEnabled;
  }

  // ------------------------------------------------------------- sign-in

  /** Starts a usernameless sign-in: no account is looked up, so the answer never reveals who exists. */
  async signInOptions(input: { tenantKey: string; ip?: string }): Promise<{ challengeId: string; options: unknown }> {
    await this.throttle(input.ip);
    const tenantId = await this.enabledTenant(input.tenantKey);
    const { challenge, options } = await this.ceremonies.assertionOptions({ relyingParty: this.relyingParty });
    const challengeId = await this.store.addChallenge({
      tenantId,
      purpose: 'assert',
      userId: null,
      challenge,
      ttlSeconds: PASSKEY_CHALLENGE_TTL_SECONDS,
    });
    return { challengeId, options };
  }

  /** Completes a sign-in with the authenticator's response. Failures all read alike. */
  async signIn(input: { tenantKey: string; challengeId: string; response: unknown; ip?: string }): Promise<PasskeySignInOutcome> {
    await this.throttle(input.ip);
    const tenantId = await this.enabledTenant(input.tenantKey);
    const refused = () => new AuthError('That passkey did not sign you in. Try again, or use another way to sign in.');

    // The challenge is consumed before anything else, so a replayed response fails.
    const challenge = UUID.test(input.challengeId)
      ? await this.store.useChallenge({ id: input.challengeId, purpose: 'assert', tenantId })
      : undefined;
    const credentialId = typeof (input.response as { id?: unknown } | null)?.id === 'string' ? (input.response as { id: string }).id : '';
    const credential = credentialId ? await this.store.byCredentialId(credentialId) : undefined;
    if (!challenge || !credential) throw refused();

    let verified: VerifiedAssertion;
    try {
      verified = await this.ceremonies.verifyAssertion({
        relyingParty: this.relyingParty,
        response: input.response,
        expectedChallenge: challenge.challenge,
        credential: {
          credentialId: credential.credential_id,
          publicKey: credential.public_key,
          counter: credential.counter,
          transports: credential.transports,
        },
      });
    } catch {
      await this.recordRefusal(tenantId, credential, 'verification');
      throw refused();
    }
    if (!verified.userVerified) {
      await this.recordRefusal(tenantId, credential, 'not-verified');
      throw refused();
    }
    if (!counterAccepted(credential.counter, verified.newCounter)) {
      // A counter that did not rise suggests the authenticator was copied; the sign-in is refused and recorded.
      await this.recordRefusal(tenantId, credential, 'counter');
      throw refused();
    }
    if (!(await this.store.advanceCounter(credential.id, credential.counter, verified.newCounter))) throw refused();

    const evidence: AuthenticationEvidence = {
      method: 'passkey',
      assurance: PASSKEY_ASSURANCE,
      authTime: new Date(),
      amr: ['hwk', 'user'],
    };
    return this.identity.signInVerifiedUser({ tenantId, userId: credential.user_id, method: 'passkey', evidence });
  }

  // ------------------------------------------------------- registration

  /**
   * Starts adding a passkey for the signed-in person. Needs a live session, and
   * the password and authenticator code once two-step is on, like other changes
   * to sign-in.
   */
  async registrationOptions(ctx: TenantContext, reauth: TwoStepReauth = {}): Promise<{ challengeId: string; options: unknown }> {
    const userId = this.personId(ctx);
    await this.identity.confirmReauthentication(ctx, reauth);
    const user = await this.accounts.summary(userId);
    if (!user) throw notFound();
    const live = await this.store.listForUser(userId);
    if (live.length >= MAX_PASSKEYS_PER_PERSON) {
      throw validationFailed(`You can keep up to ${MAX_PASSKEYS_PER_PERSON} passkeys. Remove one first.`);
    }
    const { challenge, options } = await this.ceremonies.registrationOptions({
      relyingParty: this.relyingParty,
      userId,
      userName: user.email,
      displayName: user.display_name,
      excludeCredentials: live.map((c) => ({ credentialId: c.credential_id, transports: c.transports })),
    });
    const challengeId = await this.store.addChallenge({
      tenantId: ctx.tenantId,
      purpose: 'register',
      userId,
      challenge,
      ttlSeconds: PASSKEY_CHALLENGE_TTL_SECONDS,
    });
    return { challengeId, options };
  }

  async register(ctx: TenantContext, input: { challengeId: string; response: unknown; name?: unknown }): Promise<PasskeySummary> {
    const userId = this.personId(ctx);
    const challenge = UUID.test(input.challengeId)
      ? await this.store.useChallenge({ id: input.challengeId, purpose: 'register', tenantId: ctx.tenantId, userId })
      : undefined;
    if (!challenge) throw validationFailed('That passkey request has expired. Start again.');

    let verified;
    try {
      verified = await this.ceremonies.verifyRegistration({
        relyingParty: this.relyingParty,
        response: input.response,
        expectedChallenge: challenge.challenge,
      });
    } catch {
      throw validationFailed('The passkey could not be saved. Try again on this device.');
    }
    if (!verified.userVerified) throw validationFailed('Confirm with your fingerprint, face or device PIN to save the passkey.');
    if (await this.store.byCredentialId(verified.credentialId)) throw validationFailed('This passkey is already saved.');
    if ((await this.store.countLive(userId)) >= MAX_PASSKEYS_PER_PERSON) {
      throw validationFailed(`You can keep up to ${MAX_PASSKEYS_PER_PERSON} passkeys. Remove one first.`);
    }
    const id = await this.store.add({
      userId,
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      counter: verified.counter,
      transports: verified.transports,
      deviceType: verified.deviceType,
      backedUp: verified.backedUp,
      name: passkeyName(input.name),
    });
    await this.identity.recordAudit(ctx.tenantId, { actorId: userId, action: 'passkey.added', entity: 'member', entityId: userId, after: { passkey: id } });
    const saved = (await this.store.listForUser(userId)).find((c) => c.id === id);
    if (!saved) throw notFound();
    return this.summary(saved);
  }

  // ------------------------------------------------------------ management

  async list(ctx: TenantContext): Promise<PasskeySummary[]> {
    const userId = this.personId(ctx);
    return (await this.store.listForUser(userId)).map((c) => this.summary(c));
  }

  async rename(ctx: TenantContext, id: string, name: unknown): Promise<PasskeySummary> {
    const userId = this.personId(ctx);
    if (!UUID.test(id) || !(await this.store.rename(userId, id, passkeyName(name)))) throw notFound('That passkey was not found.');
    const renamed = (await this.store.listForUser(userId)).find((c) => c.id === id);
    if (!renamed) throw notFound('That passkey was not found.');
    return this.summary(renamed);
  }

  /** Removes a passkey and ends the sign-ins made with it in this organisation. Needs the same re-proof as adding one. */
  async revoke(ctx: TenantContext, id: string, reauth: TwoStepReauth = {}): Promise<void> {
    const userId = this.personId(ctx);
    await this.identity.confirmReauthentication(ctx, reauth);
    if (!UUID.test(id) || !(await this.store.revoke(userId, id))) throw notFound('That passkey was not found.');
    await this.identity.endSessionsByMethod(ctx.tenantId, userId, 'passkey');
    await this.identity.recordAudit(ctx.tenantId, { actorId: userId, action: 'passkey.revoked', entity: 'member', entityId: userId, after: { passkey: id } });
  }

  // ---------------------------------------------------------------- helpers

  private personId(ctx: TenantContext): string {
    if (!UUID.test(ctx.actor.id)) throw forbidden('Only a signed-in person can manage passkeys.');
    return ctx.actor.id;
  }

  private async enabledTenant(tenantKey: string): Promise<string> {
    const tenantId = await this.identity.tenantIdFor(tenantKey);
    if (!tenantId || !(await this.identity.authPolicy(tenantId)).passkeyEnabled) {
      throw forbidden('Passkey sign-in is not available for this organisation.');
    }
    return tenantId;
  }

  private async throttle(ip?: string): Promise<void> {
    if (!ip) return;
    if (!(await this.limits.hit(`passkey:ip:${ip}`, PASSKEY_LIMIT.attempts, PASSKEY_LIMIT.windowSeconds))) {
      throw forbidden('Too many attempts. Try again in a few minutes.');
    }
  }

  private async recordRefusal(tenantId: string, credential: PasskeyCredentialRow, reason: string): Promise<void> {
    await this.identity.recordAudit(tenantId, {
      actorId: credential.user_id,
      action: reason === 'counter' ? 'passkey.counter_rejected' : 'passkey.sign_in_failed',
      entity: 'member',
      entityId: credential.user_id,
      after: { passkey: credential.id, reason },
    });
  }

  private summary(c: PasskeyCredentialRow): PasskeySummary {
    return {
      id: c.id,
      name: c.name,
      deviceType: c.device_type === 'multiDevice' ? 'multiDevice' : 'singleDevice',
      backedUp: c.backed_up,
      createdAt: c.created_at.toISOString(),
      lastUsedAt: c.last_used_at ? c.last_used_at.toISOString() : null,
    };
  }
}
