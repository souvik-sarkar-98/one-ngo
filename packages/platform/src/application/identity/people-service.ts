import type { MemberDirectory, MemberFilters, MemberRow, MemberStatus, TwoStepState } from '../../domain/identity/ports/identity-directory.js';
import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { conflict, notFound, validationFailed } from '@onengo/kernel/errors';
import { allOf, likePattern, listOf, oneOf, pageOf } from '../../runtime/definitions/list-params.js';
import { demand, demandAny } from '../../domain/permissions.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import type { IdentityService } from './identity-service.js';
import type { MemberStore } from '../../domain/identity/ports/member-store.js';
import type { RoleStore } from '../../domain/identity/ports/role-store.js';
import type { RolesService } from './roles-service.js';

export type { MemberStatus, TwoStepState };

export interface MemberView {
  userId: string;
  displayName: string;
  email: string;
  /** `invited`: added but never signed in here; `suspended` also covers an account switched off everywhere. */
  status: MemberStatus;
  /** `required-not-set`: one of their roles requires two-step sign-in and they have not set it up. */
  twoStep: TwoStepState;
  roles: string[];
  joinedAt: string;
  invitedAt: string | null;
  lastSignedInAt: string | null;
}

/** What `people:read` may see of a colleague; never status, two-step or invitation details. */
export interface DirectoryEntry {
  userId: string;
  displayName: string;
  email: string;
  roles: string[];
}

export interface RoleOption {
  key: string;
  label: string;
}

export interface PersonOption {
  id: string;
  name: string;
  email: string;
}

/** Active members for a person field's picker. */
export interface MemberProfiles {
  pick(ctx: TenantContext, query: { q?: unknown; limit?: unknown }): Promise<{ items: PersonOption[] }>;
}

export interface MemberPage {
  items: MemberView[];
  total: number;
  limit: number;
  offset: number;
  /** For the status chips: matches of the search and role filter, by status. */
  counts: Record<MemberStatus | 'all', number>;
  roles: RoleOption[];
}

export interface DirectoryPage {
  items: DirectoryEntry[];
  total: number;
  limit: number;
  offset: number;
  roles: RoleOption[];
}

export interface MemberListQuery {
  q?: unknown;
  role?: unknown;
  status?: unknown;
  sort?: unknown;
  dir?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export type DirectoryQuery = Pick<MemberListQuery, 'q' | 'role' | 'sort' | 'dir' | 'limit' | 'offset'>;

export interface AddMemberInput {
  email?: unknown;
  displayName?: unknown;
  roles?: unknown;
  invite?: unknown;
}

const MANAGE = 'members:manage';
const ROLES = 'admin:roles';
const DIRECTORY = 'people:read';
const STATUSES = ['active', 'invited', 'suspended'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_IDS = 200;

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

function toMember(r: MemberRow): MemberView {
  return {
    userId: r.user_id,
    displayName: r.display_name,
    email: r.email,
    status: r.status,
    twoStep: r.two_step,
    roles: r.roles,
    joinedAt: iso(r.joined_at)!,
    invitedAt: iso(r.invited_at),
    lastSignedInAt: iso(r.last_signed_in_at),
  };
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_IDS || value.some((v) => typeof v !== 'string' || !UUID.test(v))) {
    throw validationFailed(`Send userIds as a list of 1 to ${MAX_IDS} people.`, [{ path: 'userIds', message: 'A list of user ids.' }]);
  }
  return [...new Set(value as string[])];
}

/**
 * People in an organisation: the members list for administrators (status,
 * two-step state, invitations), adding, inviting, suspending and reactivating,
 * the read-only directory, and role membership. People are never deleted, so
 * their names stay on records, approvals and the audit log.
 */
export class PeopleService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly memberships: Pick<MemberStore, 'status' | 'setStatus' | 'audit'>,
    private readonly roleStore: Pick<RoleStore, 'label' | 'existing' | 'assigned' | 'assign' | 'unassign'>,
    private readonly members: MemberDirectory,
    private readonly identity: IdentityService,
    private readonly roles: RolesService,
    private readonly profiles: MemberProfiles,
  ) {}

  async list(ctx: TenantContext, query: MemberListQuery = {}): Promise<MemberPage> {
    demandAny(ctx.actor, MANAGE, ROLES);
    const filters: MemberFilters = {
      pattern: typeof query.q === 'string' && query.q.trim() ? likePattern(query.q.trim().slice(0, 200)) : undefined,
      role: listOf(query.role),
      status: allOf(listOf(query.status), STATUSES, 'status'),
    };
    const sort = oneOf(query.sort, ['name', 'joined', 'status'] as const, 'sort') ?? 'name';
    const dir = oneOf(query.dir, ['asc', 'desc'] as const, 'dir') ?? (sort === 'joined' ? 'desc' : 'asc');
    const page = pageOf(query.limit, query.offset);
    const found = await this.members.list(ctx.tenantId, filters, sort, dir, page);
    const counts = { active: 0, invited: 0, suspended: 0, all: 0 };
    for (const c of found.byStatus) {
      counts[c.status] = c.n;
      counts.all += c.n;
    }
    const total = filters.status ? filters.status.reduce((n, s) => n + counts[s], 0) : counts.all;
    return {
      items: found.rows.map((r) => toMember(r)),
      total,
      ...page,
      counts,
      roles: found.roles,
    };
  }

  async member(ctx: TenantContext, userId: string): Promise<MemberView> {
    demandAny(ctx.actor, MANAGE, ROLES);
    const [row] = await this.rows(ctx.tenantId, [userId]);
    if (!row) throw notFound('This person is not a member of the organisation.');
    return toMember(row);
  }

  /** The read-only directory: active people only, with nothing an administrator alone should see. */
  async directory(ctx: TenantContext, query: DirectoryQuery = {}): Promise<DirectoryPage> {
    demand(ctx.actor, DIRECTORY);
    oneOf(query.sort, ['name'] as const, 'sort');
    const dir = oneOf(query.dir, ['asc', 'desc'] as const, 'dir') ?? 'asc';
    const page = pageOf(query.limit, query.offset);
    const filters: MemberFilters = {
      pattern: typeof query.q === 'string' && query.q.trim() ? likePattern(query.q.trim().slice(0, 200)) : undefined,
      role: listOf(query.role),
      status: ['active'],
    };
    const found = await this.members.byName(ctx.tenantId, filters, dir, page);
    return {
      items: found.rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, email: r.email, roles: r.roles })),
      total: found.total,
      ...page,
      roles: found.roles,
    };
  }

  /** `?pick=1`: active members for a person field's picker. */
  async pick(ctx: TenantContext, query: { q?: unknown; limit?: unknown }) {
    return this.profiles.pick(ctx, query);
  }

  /**
   * Adds someone by email under the name typed here, with roles. An account they
   * already have (from another organisation) keeps its password and sign-in; it is
   * not changed here, and nothing other organisations know about it is returned.
   */
  async add(ctx: TenantContext, input: AddMemberInput): Promise<{ userId: string; email: string; displayName: string; invited: boolean }> {
    demand(ctx.actor, MANAGE);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) throw validationFailed('Enter a valid email address.', [{ path: 'email', message: 'A valid email address.' }]);
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (displayName.length > 120) throw validationFailed('Use at most 120 characters for the name.', [{ path: 'displayName', message: 'At most 120 characters.' }]);
    if (input.invite !== undefined && typeof input.invite !== 'boolean') {
      throw validationFailed('Say whether to send the invitation now.', [{ path: 'invite', message: 'true or false.' }]);
    }
    const roles = input.roles === undefined ? [] : input.roles;
    if (!Array.isArray(roles) || roles.length > 50 || roles.some((r) => typeof r !== 'string')) {
      throw validationFailed('Send the roles as a list of role keys.', [{ path: 'roles', message: 'A list of role keys.' }]);
    }
    const wanted = [...new Set(roles as string[])];
    const known = await this.transactions.withTenant(ctx.tenantId, (tx) => this.roleStore.existing(tx, wanted));
    const unknown = wanted.filter((r) => !known.includes(r));
    if (unknown.length) {
      throw validationFailed(`${unknown.length === 1 ? 'This role does not' : 'These roles do not'} exist: ${unknown.join(', ')}.`, [
        { path: 'roles', message: `Unknown: ${unknown.join(', ')}.` },
      ]);
    }
    const existing = await this.members.accountByEmail(ctx.tenantId, email);
    if (existing?.member_status === 'active') throw conflict(`${existing.display_name} (${email}) is already a member.`);
    if (existing?.member_status === 'suspended') {
      throw conflict(`${existing.display_name} (${email}) is suspended in this organisation. Reactivate them instead of adding them again.`);
    }
    // Says nothing about an account other organisations know: not its name, nor its state.
    if (existing && existing.status !== 'active') throw conflict(`${email} cannot be added. Ask the person to contact support.`);
    if (!displayName) throw validationFailed('Enter the person’s name.', [{ path: 'displayName', message: 'Required.' }]);
    const userId = await this.identity.addMember(ctx, { email, displayName, roles: wanted });
    const invited = input.invite === true;
    if (invited) await this.identity.inviteMember(ctx, userId);
    return { userId, email, displayName, invited };
  }

  /** Sends the set-password email; a new link replaces any earlier one, which stops working. */
  async invite(ctx: TenantContext, userId: string): Promise<void> {
    demand(ctx.actor, MANAGE);
    const person = await this.member(ctx, userId);
    if (person.status === 'suspended') throw conflict(`${person.displayName} is suspended. Reactivate them before sending an invitation.`);
    await this.identity.inviteMember(ctx, userId);
  }

  /** Signs them out everywhere in this organisation and blocks sign-in until reactivated. */
  async suspend(ctx: TenantContext, userId: string): Promise<MemberView> {
    demand(ctx.actor, MANAGE);
    if (userId === ctx.actor.id) throw validationFailed('You cannot suspend yourself.');
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const status = await this.membershipStatus(tx, userId);
      if (status === 'suspended') throw conflict('This person is already suspended.');
      const holdersBefore = await this.roles.roleAdmins(tx);
      await this.memberships.setStatus(tx, userId, 'suspended');
      await this.roles.keepRoleAdmin(tx, holdersBefore);
      await this.memberships.audit(tx, { actorId: ctx.actor.id, action: 'member.suspended', entity: 'member', entityId: userId });
    });
    await this.identity.endSessions(ctx.tenantId, userId);
    return this.member(ctx, userId);
  }

  async reactivate(ctx: TenantContext, userId: string): Promise<MemberView> {
    demand(ctx.actor, MANAGE);
    const person = await this.member(ctx, userId);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      if ((await this.membershipStatus(tx, userId)) !== 'suspended') throw conflict(`${person.displayName} is not suspended.`);
      await this.memberships.setStatus(tx, userId, 'active');
      await this.memberships.audit(tx, { actorId: ctx.actor.id, action: 'member.reactivated', entity: 'member', entityId: userId });
    });
    this.identity.forgetActors();
    return this.member(ctx, userId);
  }

  // ------------------------------------------------------- role membership

  async roleMembers(ctx: TenantContext, key: string, query: MemberListQuery = {}): Promise<MemberPage & { role: RoleOption }> {
    demandAny(ctx.actor, MANAGE, ROLES);
    const role = await this.transactions.withTenant(ctx.tenantId, (tx) => this.role(tx, key));
    return { role, ...(await this.list(ctx, { ...query, role: [key] })) };
  }

  /** Gives the role to active or invited people; those who already hold it are left as they are. */
  async addRoleMembers(ctx: TenantContext, key: string, input: { userIds?: unknown }): Promise<MemberPage & { role: RoleOption }> {
    demandAny(ctx.actor, MANAGE, ROLES);
    const ids = idsOf(input.userIds);
    const people = await this.rows(ctx.tenantId, ids);
    const missing = ids.filter((id) => !people.some((p) => p.user_id === id));
    if (missing.length) throw validationFailed('Some of these people are not members of the organisation.', [{ path: 'userIds', message: `Not members: ${missing.join(', ')}.` }]);
    const suspended = people.filter((p) => p.status === 'suspended');
    if (suspended.length) {
      throw validationFailed(`Suspended people cannot be given a role: ${suspended.map((p) => p.display_name).join(', ')}.`, [
        { path: 'userIds', message: 'Reactivate them first.' },
      ]);
    }
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      await this.role(tx, key);
      const receiving = people.filter((x) => !x.roles.includes(key));
      if (receiving.length) await this.roles.demandGrantable(tx, ctx, receiving.map((p) => p.user_id), [key]);
      for (const p of receiving) {
        await this.roleStore.assign(tx, p.user_id, key, ctx.actor.id);
        await this.memberships.audit(tx, {
          actorId: ctx.actor.id,
          action: 'member.roles.changed',
          entity: 'member',
          entityId: p.user_id,
          before: { roles: p.roles },
          after: { roles: [...p.roles, key].sort() },
        });
      }
    });
    this.identity.forgetActors();
    return this.roleMembers(ctx, key);
  }

  /** Same lock-out guard as replacing a person's roles. */
  async removeRoleMember(ctx: TenantContext, key: string, userId: string): Promise<void> {
    demandAny(ctx.actor, MANAGE, ROLES);
    if (!UUID.test(userId)) throw notFound('This person does not have this role.');
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const role = await this.role(tx, key);
      const before = await this.roleStore.assigned(tx, userId);
      if (!before.includes(key)) throw notFound(`This person does not have the role '${role.label}'.`);
      const holdersBefore = await this.roles.roleAdmins(tx);
      await this.roleStore.unassign(tx, userId, key);
      await this.roles.keepRoleAdmin(tx, holdersBefore);
      await this.memberships.audit(tx, {
        actorId: ctx.actor.id,
        action: 'member.roles.changed',
        entity: 'member',
        entityId: userId,
        before: { roles: before },
        after: { roles: before.filter((r) => r !== key) },
      });
    });
    this.identity.forgetActors();
  }

  // --------------------------------------------------------------- internals

  private async rows(tenantId: string, userIds: string[]): Promise<MemberRow[]> {
    const ids = userIds.filter((id) => UUID.test(id));
    if (!ids.length) return [];
    return this.members.rows(tenantId, ids);
  }

  private async role(tx: Tx, key: string): Promise<RoleOption> {
    const role = await this.roleStore.label(tx, key);
    if (!role) throw notFound(`Role '${key}' does not exist.`);
    return role;
  }

  private async membershipStatus(tx: Tx, userId: string): Promise<string> {
    const status = UUID.test(userId) ? await this.memberships.status(tx, userId) : undefined;
    if (status === undefined) throw notFound('This person is not a member of the organisation.');
    return status;
  }
}
