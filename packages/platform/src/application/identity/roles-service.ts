import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { conflict, forbidden, notFound, validationFailed } from '@onengo/kernel/errors';
import { can, demand, demandAny, demandGrant, permissionMatches } from '../../domain/permissions.js';
import type { TransactionManager, Tx } from '../../domain/ports/transaction.js';
import { actionPermission } from '../../runtime/definitions/action-permissions.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import { accessElements, permissionDefs, reportPermission, usedPermissionLabels } from '../../runtime/definitions/permission-usage.js';
import { sharingPermissionsByType } from '../../runtime/definitions/record-permissions.js';
import type { IdentityService } from './identity-service.js';
import { holdsRoleAdmin, MAX_PERMISSIONS, PERMISSION_TEXT, ROLE_KEY, ROLES_PERMISSION } from '../../domain/identity/role-policy.js';
import type { MemberStore } from '../../domain/identity/ports/member-store.js';
import type { RoleStore } from '../../domain/identity/ports/role-store.js';

export interface RoleView {
  key: string;
  label: string;
  permissions: string[];
  requireTwoStep: boolean;
  customised: boolean;
  members: number;
}

export interface RoleInput {
  key?: unknown;
  label?: unknown;
  permissions?: unknown;
  requireTwoStep?: unknown;
}

export interface CatalogueGroup {
  key: string;
  label: string;
  kind: 'recordType' | 'money' | 'setup' | 'reports' | 'used';
}

export interface CatalogueEntry {
  permission: string;
  label: string;
  group: string;
}

export interface PermissionCatalogue {
  groups: CatalogueGroup[];
  entries: CatalogueEntry[];
}

const PERMISSION = ROLES_PERMISSION;

/** Labels ending "(API only)" have no screen in the web app yet: the permission only opens the API. */
const MONEY: [string, string][] = [
  ['payments:create', 'Take payments (API only)'],
  ['payments:confirm', 'Confirm payments received (API only)'],
  ['payments:configure', 'Set up payment providers (API only)'],
  ['money:accounts:read', 'See money accounts (API only)'],
  ['money:accounts:manage', 'Open and change money accounts (API only)'],
  ['money:transfer', 'Move money between accounts (API only)'],
];

const SETUP: [string, string][] = [
  ['config:read', 'See the setup'],
  ['config:publish', 'Change and publish the setup'],
  ['config:script:publish', 'Publish scripts'],
  ['config:script:admin', 'Publish and try scripts and reports that read the ledger or run as a role'],
  ['config:modules', 'Turn modules on and off'],
  ['people:read', 'See people'],
  ['members:manage', 'Manage people'],
  ['admin:roles', 'Manage roles'],
  ['auth:configure', 'Set up sign-in providers (API only)'],
  ['admin:connectors', 'Set up SMS, WhatsApp, webhook, HTTP and account sign-in connectors'],
  ['admin:api-keys', 'Manage API keys'],
  ['admin:jobs', "See and cancel other people's background jobs"],
  ['admin:audit', 'See the audit log'],
  ['admin:settings', 'Change organisation settings'],
  ['data:export', "Export all of the organisation's data (API only)"],
  ['data:migrate', 'Bring in CSV files from another system'],
  ['data:migrate:books', 'Set opening balances and receipt numbers when migrating'],
  ['privacy:consent:read', 'See consent records (API only)'],
  ['privacy:consent:record', 'Record consent given or withdrawn (API only)'],
  ['privacy:erase', 'Erase a person (pseudonymise their personal data) (API only)'],
];

/** "Donations" → "donations", keeping words like "PAN" as written. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/**
 * Roles and access: organisation roles with their permissions and two-step
 * requirement, who holds which role, and the permission catalogue the grid is
 * drawn from. Any edit marks a role as customised, so module re-syncs keep it.
 */
export class RolesService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: RoleStore,
    private readonly members: Pick<MemberStore, 'isMember'>,
    private readonly definitions: DefinitionService,
    private readonly identity: IdentityService,
  ) {}

  /**
   * Roles with member counts. People who manage people or API keys see the
   * list to choose roles from, without what each role allows.
   */
  async list(ctx: TenantContext): Promise<RoleView[]> {
    demandAny(ctx.actor, PERMISSION, 'members:manage', 'admin:api-keys');
    const roles = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.roles(tx));
    return can(ctx.actor, PERMISSION) ? roles : roles.map((r) => ({ ...r, permissions: [] }));
  }

  /** The names of roles the caller holds, for their own profile; any member may read these. */
  async namesOf(ctx: TenantContext, keys: readonly string[]): Promise<string[]> {
    const own = keys.filter((k) => ctx.actor.roles.includes(k));
    if (!own.length) return [];
    const roles = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.roles(tx));
    const names = new Map(roles.map((r) => [r.key, r.label]));
    return own.map((k) => names.get(k) ?? k);
  }

  async get(ctx: TenantContext, key: string): Promise<RoleView> {
    demand(ctx.actor, PERMISSION);
    const [role] = await this.transactions.withTenant(ctx.tenantId, (tx) => this.store.roles(tx, key));
    if (!role) throw notFound(`Role '${key}' does not exist.`);
    return role;
  }

  async create(ctx: TenantContext, input: RoleInput): Promise<RoleView> {
    demand(ctx.actor, PERMISSION);
    if (typeof input.key !== 'string' || !ROLE_KEY.test(input.key)) {
      throw validationFailed('Role key must start with a lowercase letter and use lowercase letters, digits, - or _.', [
        { path: 'key', message: 'Use lowercase letters, digits, - or _.' },
      ]);
    }
    const key = input.key;
    const role = this.parse(input, { label: undefined, permissions: [], requireTwoStep: false });
    const saved = await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      if (await this.store.exists(tx, key)) throw conflict(`A role with the key '${key}' already exists.`);
      await this.store.create(tx, key, role);
      await this.store.audit(tx, { actorId: ctx.actor.id, action: 'role.created', entity: 'role', entityId: key, after: role });
      return (await this.store.roles(tx, key))[0]!;
    });
    this.identity.forgetActors();
    return saved;
  }

  async update(ctx: TenantContext, key: string, input: RoleInput): Promise<RoleView> {
    demand(ctx.actor, PERMISSION);
    const saved = await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const [before] = await this.store.roles(tx, key);
      if (!before) throw notFound(`Role '${key}' does not exist.`);
      const role = this.parse(input, before);
      const holdersBefore = await this.roleAdmins(tx);
      await this.store.update(tx, key, role);
      await this.keepRoleAdmin(tx, holdersBefore);
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'role.updated',
        entity: 'role',
        entityId: key,
        before: { label: before.label, permissions: before.permissions, requireTwoStep: before.requireTwoStep },
        after: role,
      });
      return (await this.store.roles(tx, key))[0]!;
    });
    this.identity.forgetActors();
    return saved;
  }

  async remove(ctx: TenantContext, key: string): Promise<void> {
    demand(ctx.actor, PERMISSION);
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      const [role] = await this.store.roles(tx, key);
      if (!role) throw notFound(`Role '${key}' does not exist.`);
      if (role.members > 0) {
        throw conflict(`'${role.label}' still has ${role.members} ${role.members === 1 ? 'member' : 'members'}. Move them to another role first.`);
      }
      if ((await this.store.apiKeysUsing(tx, key)) > 0) throw conflict(`'${role.label}' is used by API keys, so it cannot be deleted.`);
      await this.store.remove(tx, key);
      await this.store.audit(tx, {
        actorId: ctx.actor.id,
        action: 'role.deleted',
        entity: 'role',
        entityId: key,
        before: { label: role.label, permissions: role.permissions, requireTwoStep: role.requireTwoStep },
      });
    });
    this.identity.forgetActors();
  }

  /** Replaces a member's roles. Refuses to leave the organisation without anyone who can manage roles. */
  async setMemberRoles(ctx: TenantContext, userId: string, input: { roles?: unknown }): Promise<void> {
    demandAny(ctx.actor, 'members:manage', PERMISSION);
    if (!Array.isArray(input.roles) || input.roles.some((r) => typeof r !== 'string')) {
      throw validationFailed('Send the roles as a list of role keys.', [{ path: 'roles', message: 'A list of role keys.' }]);
    }
    const wanted = [...new Set(input.roles as string[])].sort();
    await this.transactions.withTenant(ctx.tenantId, async (tx) => {
      if (!(await this.members.isMember(tx, userId))) throw notFound('This person is not a member of the organisation.');
      const known = new Set(await this.store.existing(tx, wanted));
      const unknown = wanted.filter((r) => !known.has(r));
      if (unknown.length) {
        throw validationFailed(`${unknown.length === 1 ? 'This role does not' : 'These roles do not'} exist: ${unknown.join(', ')}.`, [
          { path: 'roles', message: `Unknown: ${unknown.join(', ')}.` },
        ]);
      }
      const before = await this.store.assigned(tx, userId);
      const added = wanted.filter((r) => !before.includes(r));
      await this.demandGrantable(tx, ctx, [userId], added);
      const holdersBefore = await this.roleAdmins(tx);
      await this.store.unassignAllExcept(tx, userId, wanted);
      for (const role of added) await this.store.add(tx, userId, role, ctx.actor.id);
      await this.keepRoleAdmin(tx, holdersBefore);
      await this.store.audit(tx, { actorId: ctx.actor.id, action: 'member.roles.changed', entity: 'member', entityId: userId, before: { roles: before }, after: { roles: wanted } });
    });
    this.identity.forgetActors();
  }

  /** Every permission the grid can switch, generated from the organisation's published definitions. */
  async catalogue(ctx: TenantContext): Promise<PermissionCatalogue> {
    demand(ctx.actor, PERMISSION);
    return this.catalogueOf(ctx.tenantId);
  }

  /** The catalogue without the permission check, for other services that already checked theirs. */
  async catalogueOf(tenantId: string): Promise<PermissionCatalogue> {
    const ctx = { tenantId };
    const types = (await this.definitions.list(ctx.tenantId, 'recordType')).map((d) => d.body).sort((a, b) => a.key.localeCompare(b.key));
    const actions = await this.definitions.list(ctx.tenantId, 'action');
    const sharing = sharingPermissionsByType(types);
    const groups: CatalogueGroup[] = [];
    const entries: CatalogueEntry[] = [];
    const add = (group: string, permission: string, label: string) => {
      if (!entries.some((e) => e.group === group && e.permission === permission)) entries.push({ permission, label, group });
    };

    for (const type of types) {
      const group = `record:${type.key}`;
      const plural = lowerFirst(type.pluralLabel ?? type.label);
      groups.push({ key: group, label: type.pluralLabel ?? type.label, kind: 'recordType' });
      add(group, `record:${type.key}:read`, `See ${plural}`);
      add(group, `record:${type.key}:create`, `Add ${plural}`);
      add(group, `record:${type.key}:update`, `Edit ${plural}`);
      add(group, `record:${type.key}:sensitive`, `See sensitive details of ${plural}`);
      for (const s of sharing[type.key] ?? []) {
        add(group, s.permission, s.key === 'read:all' ? `See all ${plural}, not only their own and shared ones` : `Share ${plural} with others`);
      }
      add(group, `record:${type.key}:import`, `Import ${plural}`);
      add(group, `record:${type.key}:import:quiet`, `Import ${plural} without running automations`);
      add(group, `record:${type.key}:export`, `Export ${plural}`);
      add(group, `record:${type.key}:bulk`, `Change many ${plural} at once`);
      for (const wf of await this.definitions.workflowsFor(ctx.tenantId, type.key)) {
        for (const t of wf.body.transitions) add(group, t.permission ?? `record:${type.key}:transition:${t.key}`, `Step: ${t.label}`);
      }
      for (const a of actions.map((d) => d.body).filter((a) => a.recordType === type.key).sort((x, y) => x.key.localeCompare(y.key))) {
        add(group, actionPermission(a), `Action: ${a.label}`);
      }
    }
    groups.push({ key: 'money', label: 'Money', kind: 'money' });
    for (const [p, label] of MONEY) add('money', p, label);
    groups.push({ key: 'setup', label: 'Setup', kind: 'setup' });
    for (const [p, label] of SETUP) add('setup', p, label);
    const defs = await permissionDefs(this.definitions, ctx.tenantId);
    if (defs.reports?.length) {
      groups.push({ key: 'reports', label: 'Reports', kind: 'reports' });
      for (const r of defs.reports) add('reports', reportPermission(r.key), `Run ${r.label}`);
    }
    const used = usedPermissionLabels(accessElements(defs));
    const others = [...used].filter(([p]) => !entries.some((e) => e.permission === p));
    if (others.length) {
      groups.push({ key: 'used', label: 'Used in definitions', kind: 'used' });
      for (const [p, label] of others) add('used', p, label);
    }
    return { groups, entries };
  }

  // --------------------------------------------------------------- internals

  private parse(
    input: RoleInput,
    current: { label: string | undefined; permissions: string[]; requireTwoStep: boolean },
  ): { label: string; permissions: string[]; requireTwoStep: boolean } {
    const label = input.label === undefined ? current.label : typeof input.label === 'string' ? input.label.trim() : '';
    if (!label || label.length > 80) throw validationFailed('Give the role a name of at most 80 characters.', [{ path: 'label', message: 'Required, at most 80 characters.' }]);
    let permissions = current.permissions;
    if (input.permissions !== undefined) {
      if (!Array.isArray(input.permissions) || input.permissions.length > MAX_PERMISSIONS) {
        throw validationFailed(`Send the permissions as a list of at most ${MAX_PERMISSIONS}.`, [{ path: 'permissions', message: 'A list of permissions.' }]);
      }
      const bad = input.permissions.filter((p) => typeof p !== 'string' || p.length > 200 || !PERMISSION_TEXT.test(p));
      if (bad.length) {
        throw validationFailed('Some permissions are not valid.', [{ path: 'permissions', message: `Not valid: ${bad.map(String).slice(0, 5).join(', ')}.` }]);
      }
      permissions = [...new Set(input.permissions as string[])];
    }
    if (input.requireTwoStep !== undefined && typeof input.requireTwoStep !== 'boolean') {
      throw validationFailed('Two-step sign-in is either required or not.', [{ path: 'requireTwoStep', message: 'true or false.' }]);
    }
    const requireTwoStep = (input.requireTwoStep as boolean | undefined) ?? current.requireTwoStep;
    return { label, permissions, requireTwoStep };
  }

  /**
   * Refuses to give `roles` to these people when they allow more than the actor holds,
   * or when the actor gives roles to themselves; people who manage roles may do both.
   */
  async demandGrantable(tx: Tx, ctx: TenantContext, userIds: string[], roles: string[]): Promise<void> {
    if (!roles.length || can(ctx.actor, PERMISSION)) return;
    if (userIds.includes(ctx.actor.id)) throw forbidden('You cannot give yourself roles. Ask someone who manages roles.');
    const grants = await this.store.grants(tx);
    demandGrant(ctx.actor, grants.filter((g) => roles.includes(g.key)));
  }

  /** Active people who may manage roles, through any of their roles. */
  async roleAdmins(tx: Tx): Promise<number> {
    const rows = await this.store.activeHolders(tx);
    return new Set(rows.filter((r) => holdsRoleAdmin(r.permissions)).map((r) => r.userId)).size;
  }

  /** Call with `roleAdmins` from before a change, in the same transaction; refuses the change if it left nobody. */
  async keepRoleAdmin(tx: Tx, holdersBefore: number): Promise<void> {
    if (holdersBefore > 0 && (await this.roleAdmins(tx)) === 0) {
      throw conflict('This would leave nobody who can manage roles and access. Give someone else that permission first.');
    }
  }
}
