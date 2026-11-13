import { currentActor } from '../application/identity/current-actor.js';
import { AccessService } from '../application/identity/access-service.js';
import { ApiKeyService } from '../application/identity/api-key-service.js';
import { IdentityService, recordUserUpdated } from '../application/identity/identity-service.js';
import { OidcService } from '../application/identity/oidc.js';
import { PasskeyService } from '../application/identity/passkey-service.js';
import { passwordLinkEmail } from '../application/identity/password-link-email.js';
import { PeopleService } from '../application/identity/people-service.js';
import type { PasskeyRelyingParty } from '../domain/identity/ports/webauthn-ceremonies.js';
import { simpleWebAuthnCeremonies } from '../infrastructure/webauthn/simplewebauthn.js';
import { PinService } from '../application/identity/pin-service.js';
import { RolesService } from '../application/identity/roles-service.js';
import { PasswordPolicy, type PasswordPolicyOptions } from '../domain/identity/password-policy.js';
import { commonPasswordsFile, pwnedPasswords, type BreachFetch } from '@onengo/kernel/crypto';
import { MemoryRateLimiter } from '@onengo/kernel/http';
import { postgresApiKeyStore } from '../infrastructure/postgres/stores/api-key-store.js';
import { postgresMemberStore, postgresSharedLimits } from '../infrastructure/postgres/stores/member-store.js';
import { postgresOidcStore } from '../infrastructure/postgres/stores/oidc-store.js';
import { postgresPinStore } from '../infrastructure/postgres/stores/pin-store.js';
import { postgresRoleStore } from '../infrastructure/postgres/stores/role-store.js';
import type { Definitions } from './definitions.js';
import type { Base, Cryptography } from './infrastructure.js';
import type { Messaging } from './messaging.js';
import type { Records } from './records.js';

/** Rules for new passwords, as the platform options state them; the breach lookup and the common-password file are wired here. */
export interface PasswordSettings extends Omit<PasswordPolicyOptions, 'logger' | 'breaches' | 'commonPasswords'> {
  timeoutMs?: number;
  /** Extra common passwords, one per line (e.g. a published top-100,000 list). */
  commonPasswordsFile?: string;
  fetch?: BreachFetch;
}

/** Sign-in, sessions, roles, people, access checks, API keys and PINs. */
export function wireIdentity(base: Base, { definitions, runtime }: Definitions, { crypto }: Cryptography, { notifications }: Messaging, { profiles }: Records) {
  const { db, tm, owner, logger, options } = base;
  const identity = new IdentityService(tm, postgresMemberStore, postgresRoleStore, postgresSharedLimits(db), owner.tenants, owner.accounts, owner.signIn, owner.sessions, {
    userUpdated: recordUserUpdated(base.audit),
    tokenSecret: options.tokenSecret,
    crypto,
    deliverEmailCode: ({ tenantId, email, code }) =>
      notifications.sendImmediateEmail(
        tenantId,
        email,
        'Your sign-in code',
        `Your sign-in code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
      ),
    publicBaseUrl: options.publicBaseUrl,
    passwordPolicy: passwordPolicy(options.passwords, logger),
    deliverPasswordLink: async ({ tenantId, email, kind, url, organisation, locale }) => {
      const { subject, body } = passwordLinkEmail(await runtime.text(tenantId, locale), { kind, url, organisation });
      await notifications.sendImmediateEmail(tenantId, email, subject, body);
    },
    localeOf: (tenantId, userId) => runtime.localeOfMember(tenantId, userId),
  });
  const oidc = new OidcService(tm, postgresOidcStore, owner.tenants, owner.identity, identity, {
    publicBaseUrl: options.publicBaseUrl ?? '',
    crypto,
    installationProviders: options.oidcProviders,
    fetch: options.oidcFetch,
  });
  const roles = new RolesService(tm, postgresRoleStore, postgresMemberStore, definitions, identity);
  const apiKeys = new ApiKeyService(tm, postgresApiKeyStore, owner.identity, crypto, definitions, (limit) => new MemoryRateLimiter(limit, 60_000));
  const passkeys = new PasskeyService(
    identity,
    owner.passkeys,
    owner.accounts,
    postgresSharedLimits(db),
    simpleWebAuthnCeremonies(),
    passkeyRelyingParty(options.publicBaseUrl, options.passkeyOrigins),
  );
  return {
    identity,
    currentActor: currentActor(tm, postgresMemberStore, postgresApiKeyStore),
    oidc,
    passkeys,
    roles,
    apiKeys,
    people: new PeopleService(tm, postgresMemberStore, postgresRoleStore, owner.members, identity, roles, profiles),
    pins: new PinService(tm, postgresPinStore),
    access: new AccessService(tm, postgresRoleStore, definitions, roles),
  };
}
/**
 * The relying party passkeys are bound to: the host of the public address, with
 * the origins a ceremony may run from. The Angular dev server (port 4200) is
 * allowed on localhost because it proxies the API; extra origins come from the
 * installation's configuration.
 */
export function passkeyRelyingParty(publicBaseUrl: string | undefined, extraOrigins: string[] = []): PasskeyRelyingParty {
  const base = new URL(publicBaseUrl ?? 'http://localhost:8080');
  const origins = new Set([base.origin]);
  if (base.hostname === 'localhost') origins.add('http://localhost:4200');
  for (const origin of extraOrigins) origins.add(new URL(origin).origin);
  return { name: 'OneNGO', id: base.hostname, origins: [...origins] };
}

function passwordPolicy(settings: PasswordSettings = {}, logger: Base['logger']): PasswordPolicy {
  const { timeoutMs, commonPasswordsFile: file, fetch, ...rules } = settings;
  return new PasswordPolicy({
    ...rules,
    commonPasswords: file ? commonPasswordsFile(file) : undefined,
    breaches: pwnedPasswords({ timeoutMs, fetch }),
    logger,
  });
}

export type Identity = ReturnType<typeof wireIdentity>;
