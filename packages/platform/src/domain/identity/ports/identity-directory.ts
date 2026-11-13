import type {
  AssuranceLevel,
  AuthenticationEvidence,
  TenantAuthPolicy,
} from './assurance.js';
/** Account, sign-in, session and member lookups the owner-level database capability provides across organisations. */
export interface OidcLoginStart {
  state_hash: string;
  tenant_id: string;
  provider: string;
  nonce: string;
  code_verifier: string;
  next_path: string;
}

export interface OidcLogin {
  tenant_id: string;
  provider: string;
  nonce: string;
  code_verifier: string;
  next_path: string;
}

export type OidcMemberResult = { userId: string } | { refused: 'no-member' | 'linked-elsewhere' };

export interface ApiKeyCredential {
  tenant_id: string;
  name: string;
  secret_hash: string;
  role_key: string | null;
  feed_key: string | null;
  permissions: string[] | null;
  revoked_at: Date | null;
  rate: unknown;
}

/** Sign-in lookups made before the organisation is known, or across organisations. */
export interface SystemIdentity {
  startOidcLogin(login: OidcLoginStart): Promise<void>;
  /** Marks an unexpired, unused login used and returns it. */
  useOidcLogin(stateHash: string): Promise<OidcLogin | undefined>;
  /**
   * The active member for a verified provider identity, linking it to the
   * account with that email on first use. Nothing is linked when refused.
   */
  oidcMember(tenantId: string, claims: { sub: string; email: string; iss: string }): Promise<OidcMemberResult>;
  /** The key, its role's permissions when it has a role, and the organisation's rate setting. */
  apiKey(id: string, rateSetting: string): Promise<ApiKeyCredential | undefined>;
  /** Records use of the key, at most once a minute. */
  touchApiKey(id: string): Promise<void>;
}

export interface AccountRow {
  id: string;
  email: string;
  password_hash: string | null;
  totp_secret_enc: string | null;
  totp_enabled: boolean;
  status: string;
}

/** Accounts, shared by every organisation their person belongs to, and the memberships sign-in checks. */
export interface AccountStore {
  /** The account with this address, created with this name when there is none; an existing one is left as it is. */
  add(email: string, displayName: string): Promise<string>;
  /** Matches the address case-insensitively; pass it lowercased. */
  byEmail(email: string): Promise<AccountRow | undefined>;
  byId(userId: string): Promise<AccountRow | undefined>;
  summary(userId: string): Promise<{ display_name: string; email: string; totp_enabled: boolean } | undefined>;
  /** What a new password must not contain: the person's details and the names and keys of their organisations. */
  passwordContext(userId: string): Promise<{ email?: string; displayName?: string; organisationNames: string[] }>;
  setPasswordHash(userId: string, hash: string): Promise<void>;
  /** Stores a pending two-step secret; an enrolled one stays in force until the pending one is confirmed. Returns the account's email. */
  startTwoStep(userId: string, secretEnc: string): Promise<string | undefined>;
  pendingTwoStepSecret(userId: string): Promise<string | null | undefined>;
  /** Makes the pending secret, while it is still `secretEnc`, the enrolled one and switches two-step on; false when it changed meanwhile. */
  confirmTwoStep(userId: string, secretEnc: string): Promise<boolean>;
  /** Records `step` as the last accepted two-step time step; false when that step or a later one was already used. */
  useTwoStepStep(userId: string, step: number): Promise<boolean>;
  /** The email of an account that is not switched off. */
  activeEmail(userId: string): Promise<string | undefined>;
  isActiveMember(tenantId: string, userId: string): Promise<boolean>;
  rolesRequireTwoStep(tenantId: string, userId: string): Promise<boolean>;
}

export interface PasswordTokenInput {
  userId: string;
  tenantId: string;
  purpose: 'reset' | 'invite' | 'two_step';
  tokenHash: string;
  ttlMinutes: number;
  createdBy: string | null;
  evidence?: AuthenticationEvidence;
}

/** One-time sign-in credentials (emailed codes, reset and invitation links, two-step tickets) and failed-attempt throttling. */
export interface SignInStore {
  addEmailCode(email: string, tenantId: string, codeHash: string, ttlMinutes: number): Promise<void>;
  /** Uses the newest live code for the address when it has this hash; a wrong code counts an attempt, and five end it. */
  useEmailCode(email: string, tenantId: string, codeHash: string): Promise<boolean>;
  /** Earlier unused tokens of the same purpose stop working, except two-step tickets. */
  addPasswordToken(token: PasswordTokenInput): Promise<void>;
  /** A live reset or invitation token, with its organisation's key. */
  openPasswordToken(tokenHash: string): Promise<{ id: string; user_id: string; tenant_id: string; purpose: string; key: string } | undefined>;
  /** Uses every open reset and invitation token of the person, and ends all their sessions. */
  finishPasswordTokens(userId: string): Promise<void>;
  /**
   * Uses a live two-step ticket when `verify` finds the code's time step under the account's encrypted
   * secret and that step is later than the last one accepted; a refused code counts an attempt, and five end it.
   */
  useTwoStepTicket(
    tokenHash: string,
    verify: (secretEnc: string) => number | null,
  ): Promise<{ userId: string; tenantId: string; evidence?: AuthenticationEvidence } | null>;
  isLocked(keys: string[]): Promise<boolean>;
  /** Counts a failure on each key, restarting counts older than `lockMinutes`, and locks a key at its limit for `lockMinutes`. */
  recordFailures(keys: { key: string; limit: number }[], lockMinutes: number): Promise<void>;
  clearFailures(key: string): Promise<void>;
  authPolicy(tenantId: string): Promise<TenantAuthPolicy>;
  /**
   * Changes NGO policy under a tenant row lock. Passwords may be switched off
   * only while at least two active auth administrators retain a compliant method.
   */
  saveAuthPolicy(
    tenantId: string,
    policy: TenantAuthPolicy,
    updatedBy: string,
  ): Promise<'saved' | 'needs-two-protected-admins'>;
  providerPolicy(tenantId: string, providerId: string): Promise<ProviderPolicy | undefined>;
  /** Every provider the organisation has a policy for, enabled or not. */
  providerPolicies(tenantId: string): Promise<(ProviderPolicy & { providerId: string; updatedAt: Date })[]>;
  /** An undefined `allowedDomains` keeps the stored list. */
  saveProviderPolicy(
    tenantId: string,
    providerId: string,
    policy: { enabled: boolean; assurance: AssuranceLevel; allowedDomains?: string[] },
    updatedBy: string,
  ): Promise<void>;
}

/** An organisation's opt-in to a provider. `allowedDomains` narrows the provider's own list; empty adds no limit. */
export interface ProviderPolicy {
  enabled: boolean;
  assurance: AssuranceLevel;
  allowedDomains: string[];
}

export type SessionRotation =
  | { refused: 'ended' | 'removed' }
  | { reusedFamily: string }
  | { userId: string; tenantId: string; familyId: string; evidence: AuthenticationEvidence };

/** Refresh tokens. A session is a family of tokens, each replacing the one before. */
export interface SessionStore {
  /** Stores the first refresh token of a new session and marks the sign-in; returns the session id. */
  start(userId: string, tenantId: string, tokenHash: string, ttlSeconds: number, evidence: AuthenticationEvidence): Promise<string>;
  /**
   * Replaces a live refresh token by the next one of its session while the
   * person and their membership are active. A token already replaced comes
   * back as `reusedFamily`, and nothing changes.
   */
  rotate(tokenHash: string, nextHash: string, ttlSeconds: number): Promise<SessionRotation>;
  endFamily(familyId: string): Promise<void>;
  /** Whether the person's session in the organisation still has a live refresh token: not signed out, revoked or expired. */
  isLive(familyId: string, userId: string, tenantId: string): Promise<boolean>;
  /** Ends the session the token belongs to. */
  endByToken(tokenHash: string): Promise<void>;
  endForMember(tenantId: string, userId: string): Promise<void>;
  /** Ends only sessions established with this exact method. */
  endForMethod(tenantId: string, userId: string, method: string): Promise<void>;
  /** Ends this method for every member of the NGO, leaving other methods live. */
  endForTenantMethod(tenantId: string, method: string): Promise<void>;
}

export type MemberStatus = 'active' | 'invited' | 'suspended';
export type TwoStepState = 'on' | 'off' | 'required-not-set';

export interface MemberRow {
  user_id: string;
  display_name: string;
  email: string;
  status: MemberStatus;
  two_step: TwoStepState;
  roles: string[];
  joined_at: Date | string;
  invited_at: Date | string | null;
  last_signed_in_at: Date | string | null;
}

export interface MemberFilters {
  /** Name or email search as a `like` pattern with its wildcards escaped (escape '\'), built by the caller. */
  pattern?: string;
  role?: string[];
  status?: MemberStatus[];
  userIds?: string[];
}

export type MemberSort = 'name' | 'joined' | 'status';

/** An organisation's members with account details (name, email, two-step state), which live on accounts shared across organisations. */
export interface MemberDirectory {
  /** A page of members, the matches by status ignoring the status filter, and the organisation's roles. */
  list(
    tenantId: string,
    filters: MemberFilters,
    sort: MemberSort,
    dir: 'asc' | 'desc',
    page: { limit: number; offset: number },
  ): Promise<{ rows: MemberRow[]; byStatus: { status: MemberStatus; n: number }[]; roles: { key: string; label: string }[] }>;
  /** A page by name, the total and the organisation's roles. */
  byName(
    tenantId: string,
    filters: MemberFilters,
    dir: 'asc' | 'desc',
    page: { limit: number; offset: number },
  ): Promise<{ rows: MemberRow[]; total: number; roles: { key: string; label: string }[] }>;
  rows(tenantId: string, userIds: string[]): Promise<MemberRow[]>;
  /** The account with this lowercased address, and its membership status here if any. */
  accountByEmail(tenantId: string, email: string): Promise<{ display_name: string; status: string; member_status: string | null } | undefined>;
  /** `status` is active only while both the account and the membership are. */
  member(tenantId: string, userId: string): Promise<{ display_name: string; email: string; status: string } | undefined>;
}
