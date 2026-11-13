import type { TenantContext } from '../../domain/ports/tenant-context.js';
import { forbidden, notFound, validationFailed } from '@onengo/kernel/errors';
import { can, demand, permissionMatches } from '../../domain/permissions.js';
import { ROLES_PERMISSION } from '../../domain/identity/role-policy.js';
import type { TransactionManager } from '../../domain/ports/transaction.js';
import type { DefinitionService } from '../../runtime/definitions/definition-service.js';
import {
  accessElements,
  generatedPermissions,
  isKnownPermission,
  permissionDefs,
  permissionUses,
  type AccessArea,
  type AccessElement,
} from '../../runtime/definitions/permission-usage.js';
import type { RoleStore } from '../../domain/identity/ports/role-store.js';
import type { RolesService } from './roles-service.js';

const PERMISSION = 'config:read';
const AREAS: AccessArea[] = ['records', 'pages', 'app'];
const SUGGESTIONS_MAX = 50;

export interface PermissionSuggestion {
  permission: string;
  label: string;
  /** Generated from the definitions (or an app permission), or only written in definitions. */
  source: 'generated' | 'used';
  usedIn: { label: string; kind: string; key: string; path: string }[];
  /** How many roles hold it, through any grant including wildcards; 0 for someone who does not manage roles. */
  roles: number;
}

export interface AccessMapElement extends AccessElement {
  /** Keys of the roles holding the permission (every role for elements without one); empty for someone who does not manage roles. */
  roles: string[];
  warnings: string[];
  /** With a role: whether that role sees or can use the element. */
  visible?: boolean;
}

export interface AccessMap {
  elements: AccessMapElement[];
  role?: { key: string; label: string; summary: string };
}

export interface AccessMapQuery {
  area?: string;
  recordType?: string;
  role?: string;
  problems?: boolean;
}

interface RoleRow {
  key: string;
  label: string;
  permissions: string[];
}

const holds = (role: RoleRow, permission: string) => role.permissions.some((g) => permissionMatches(g, permission));

/**
 * What each part of the organisation's screens requires and who holds it,
 * for the Builder's permission autocomplete and access map. There is no
 * permission definition: permissions are generated or written as text.
 * Which roles hold what is shown only to people who manage roles, as in
 * `RolesService.list`.
 */
export class AccessService {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly store: Pick<RoleStore, 'grants'>,
    private readonly definitions: DefinitionService,
    private readonly roles: RolesService,
  ) {}

  /** Generated permissions and every permission string used in definitions, matching `q`. */
  async suggestions(ctx: TenantContext, q?: string): Promise<PermissionSuggestion[]> {
    demand(ctx.actor, PERMISSION);
    const [catalogue, elements, roles] = [
      await this.roles.catalogueOf(ctx.tenantId),
      accessElements(await permissionDefs(this.definitions, ctx.tenantId)),
      can(ctx.actor, ROLES_PERMISSION) ? await this.roleRows(ctx) : [],
    ];
    const uses = permissionUses(elements);
    const out = new Map<string, PermissionSuggestion>();
    const add = (permission: string, label: string, source: PermissionSuggestion['source']) => {
      if (out.has(permission)) return;
      out.set(permission, {
        permission,
        label,
        source,
        usedIn: (uses.get(permission) ?? []).map((u) => ({ label: u.label, kind: u.definition!.kind, key: u.definition!.key, path: u.definition!.path })),
        roles: roles.filter((r) => holds(r, permission)).length,
      });
    };
    for (const e of catalogue.entries) add(e.permission, e.label, e.group === 'used' ? 'used' : 'generated');
    for (const e of elements) if (e.element === 'area' && e.permission) add(e.permission, e.label, 'generated');
    for (const [p, list] of uses) add(p, list[0]!.label, 'used');
    const text = q?.trim().toLowerCase();
    const matches = [...out.values()].filter((s) => !text || s.permission.toLowerCase().includes(text) || s.label.toLowerCase().includes(text));
    return matches.slice(0, SUGGESTIONS_MAX);
  }

  /** Every element with its permission, the roles holding it and warnings; with a role, what that role sees. */
  async accessMap(ctx: TenantContext, query: AccessMapQuery = {}): Promise<AccessMap> {
    demand(ctx.actor, PERMISSION);
    const seesRoles = can(ctx.actor, ROLES_PERMISSION);
    if (query.role && !seesRoles) throw forbidden('Only people who manage roles can see what a role sees.');
    if (query.area && !AREAS.includes(query.area as AccessArea)) throw validationFailed(`area must be one of ${AREAS.join(', ')}.`);
    const defs = await permissionDefs(this.definitions, ctx.tenantId);
    const roles = await this.roleRows(ctx);
    const role = query.role ? roles.find((r) => r.key === query.role) : undefined;
    if (query.role && !role) throw notFound(`Role '${query.role}' does not exist.`);
    if (query.recordType && !defs.recordTypes.some((t) => t.key === query.recordType)) throw notFound(`Unknown record type '${query.recordType}'.`);

    const generated = generatedPermissions(defs);
    const grants = roles.flatMap((r) => r.permissions);
    const audiences = new Map(defs.pages.map((p) => [p.key, p.audience ?? []]));
    const reportAudiences = new Map((defs.reports ?? []).map((r) => [r.key, r.audience ?? []]));
    const elements: AccessMapElement[] = accessElements(defs)
      .filter((e) => (!query.area || e.area === query.area) && (!query.recordType || e.recordType === query.recordType))
      .map((e) => {
        const kind = e.definition?.kind;
        const audience = kind === 'page' ? audiences.get(e.definition!.key) : kind === 'report' ? reportAudiences.get(e.definition!.key) : undefined;
        const holders = audience?.length ? roles.filter((r) => audience.includes(r.key)) : roles;
        const holding = e.permission ? holders.filter((r) => holds(r, e.permission!)) : holders;
        const warnings: string[] = [];
        if (e.permission && !isKnownPermission(e.permission, generated, grants)) warnings.push(`No role has '${e.permission}' yet.`);
        if (e.element === 'page') e.audience?.filter((k) => !roles.some((r) => r.key === k)).forEach((k) => warnings.push(`Role '${k}' does not exist.`));
        return {
          ...e,
          roles: seesRoles ? holding.map((r) => r.key) : [],
          warnings,
          ...(role ? { visible: holding.some((r) => r.key === role.key) } : {}),
        };
      })
      .filter((e) => !query.problems || e.warnings.length > 0);
    return { elements, ...(role ? { role: { key: role.key, label: role.label, summary: summarise(role.label, elements) } } : {}) };
  }

  private roleRows(ctx: TenantContext): Promise<RoleRow[]> {
    return this.transactions.withTenant(ctx.tenantId, (tx) => this.store.grants(tx));
  }
}

/** "Viewer sees 2 of 3 record types; 1 field is masked; …" in plain language. */
function summarise(label: string, elements: AccessMapElement[]): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const of = (kind: AccessElement['element'], access?: AccessElement['access']) => elements.filter((e) => e.element === kind && (!access || e.access === access));
  const hidden = (list: AccessMapElement[]) => list.filter((e) => !e.visible).length;
  const types = of('recordType', 'see');
  const parts = [`${label} sees ${types.filter((e) => e.visible).length} of ${count(types.length, 'record type', 'record types')}`];
  const seen = new Set(types.filter((e) => e.visible).map((e) => e.recordType));
  const inSeen = (list: AccessMapElement[]) => list.filter((e) => !e.recordType || seen.has(e.recordType));
  const masked = hidden(inSeen(of('field', 'see')));
  const readOnly = hidden(inSeen(of('field', 'change')));
  if (masked) parts.push(`${count(masked, 'field is', 'fields are')} masked`);
  if (readOnly) parts.push(`${count(readOnly, 'field is', 'fields are')} read-only`);
  const left = [
    [hidden(inSeen(of('section'))), 'section', 'sections'],
    [hidden(inSeen(of('chip'))), 'chip', 'chips'],
    [hidden(of('widget')), 'widget', 'widgets'],
    [hidden(of('link')), 'link', 'links'],
    [hidden(of('page')), 'page', 'pages'],
  ] as const;
  const hiddenParts = left.filter(([n]) => n > 0).map(([n, one, many]) => count(n, one, many));
  if (hiddenParts.length) parts.push(`hidden: ${hiddenParts.join(', ')}`);
  const steps = hidden(inSeen(of('step')));
  const actions = hidden(inSeen(of('action')));
  if (steps || actions) parts.push(`not available: ${[steps && count(steps, 'step', 'steps'), actions && count(actions, 'action', 'actions')].filter(Boolean).join(', ')}`);
  return `${parts.join('; ')}.`;
}
