import { permissionMatches } from '../server';
import { flag, oneOf, text, type ParamReader, type Params } from '../address';
import { t } from '../i18n/i18n';
import { elementId, type PendingChange } from './access-drafts';
import type { AccessElementKind, AccessMapElement } from './http-access';
import { holds } from './permission-grid';

/** The access map's chips: every element, or one area of the screens. */
export const ACCESS_CHIPS = ['all', 'recordTypes', 'fields', 'sections', 'chips', 'steps', 'pages', 'app'] as const;
export type AccessChip = (typeof ACCESS_CHIPS)[number];

const CHIP_ELEMENTS: Record<Exclude<AccessChip, 'all'>, AccessElementKind[]> = {
  recordTypes: ['recordType', 'toolbar'],
  fields: ['field'],
  sections: ['section'],
  chips: ['chip'],
  steps: ['step', 'action'],
  pages: ['page', 'widget', 'link'],
  app: ['area'],
};

/** `/builder/access?area=&recordType=&heldBy=&q=&problems=1`; with `role`, the role view. */
export interface AccessAddress {
  area: AccessChip;
  recordType?: string;
  /** Only elements this role holds. */
  heldBy?: string;
  q: string;
  problems: boolean;
  /** What this role sees (Builder 25). */
  role?: string;
}

const AREA = oneOf(ACCESS_CHIPS);
const NAME = text();
const PROBLEMS = flag('1', null);

export function parseAccessAddress(get: ParamReader): AccessAddress {
  const recordType = NAME.read(get, 'recordType');
  const heldBy = NAME.read(get, 'heldBy');
  const role = NAME.read(get, 'role');
  return {
    area: AREA.read(get, 'area') ?? 'all',
    ...(recordType && { recordType }),
    ...(heldBy && { heldBy }),
    q: NAME.read(get, 'q') ?? '',
    problems: PROBLEMS.read(get, 'problems') ?? false,
    ...(role && { role }),
  };
}

export function accessParams(change: Partial<AccessAddress>): Params {
  const out: Params = {};
  if ('area' in change) Object.assign(out, AREA.write('area', change.area === 'all' ? undefined : change.area));
  if ('recordType' in change) Object.assign(out, NAME.write('recordType', change.recordType || undefined));
  if ('heldBy' in change) Object.assign(out, NAME.write('heldBy', change.heldBy || undefined));
  if ('q' in change) Object.assign(out, NAME.write('q', change.q || undefined));
  if ('problems' in change) Object.assign(out, PROBLEMS.write('problems', change.problems || undefined));
  if ('role' in change) Object.assign(out, NAME.write('role', change.role || undefined));
  return out;
}

/** A role as the access map needs it; permissions are known only to people who may manage roles. */
export interface RoleInfo {
  key: string;
  label: string;
  permissions?: string[];
}

const rolesKnown = (roles: RoleInfo[]) => roles.length > 0 && roles.every((r) => !!r.permissions);

/**
 * The elements as they will be once the pending changes are published: the
 * new permission, the roles holding it and, for a role view, whether that
 * role sees it. Without the roles' permissions the server's answer stays.
 */
export function withChanges(elements: AccessMapElement[], pending: PendingChange[], roles: RoleInfo[], role?: string): AccessMapElement[] {
  if (!pending.length) return elements;
  const changes = new Map(pending.map((p) => [p.id, p]));
  const known = rolesKnown(roles);
  return elements.map((e) => {
    const c = changes.get(elementId(e));
    if (!c) return e;
    const permission = c.permission;
    const holders = known ? roles.filter((r) => permission === null || holds(r.permissions!, permission)).map((r) => r.key) : e.roles;
    return {
      ...e,
      permission,
      explicit: !!c.value,
      roles: holders,
      warnings: [],
      ...(role !== undefined && { visible: holders.includes(role) }),
    };
  });
}

/** Whether no role holds the element's permission except through the grant of everything (`*`). */
export function heldByNoRole(e: AccessMapElement, roles: RoleInfo[]): boolean {
  if (!e.permission) return false;
  if (e.warnings.length) return true;
  if (!e.overridable || !rolesKnown(roles)) return false;
  return !roles.some((r) => r.permissions!.some((g) => g !== '*' && permissionMatches(g, e.permission!)));
}

export interface AccessRow {
  id: string;
  element: AccessMapElement;
  label: string;
  where: string;
  permission: string | null;
  /** How the permission is set: fixed, from "Sensitive", the default, or the page audience. */
  note: string;
  holders: string;
  noRole: boolean;
  changed: boolean;
}

export interface AccessGroup {
  id: string;
  label: string;
  rows: AccessRow[];
}

/** A permission no role holds, with the elements nobody therefore sees. */
export interface AccessProblem {
  permission: string;
  labels: string[];
}

export interface AccessView {
  groups: AccessGroup[];
  problems: AccessProblem[];
  count: number;
}

const ORDER: AccessElementKind[] = ['recordType', 'toolbar', 'field', 'section', 'chip', 'step', 'action', 'page', 'widget', 'link', 'area'];

function note(e: AccessMapElement, roles: Map<string, string>): string {
  if (e.element === 'page') {
    const audience = e.audience ?? [];
    return audience.length ? t('ui.builder.access.audience', { roles: audience.map((k) => roles.get(k) ?? k).join(', ') }) : t('ui.builder.access.audienceAll');
  }
  if (!e.overridable) return e.permission ? t('ui.builder.access.fixed') : '';
  if (e.explicit) return '';
  if (e.element === 'field' && e.access === 'see' && e.permission?.endsWith(':sensitive')) return t('ui.builder.access.fromSensitive');
  return t('ui.builder.access.default');
}

function where(e: AccessMapElement): string {
  const kind = t(`ui.builder.access.element.${e.element}`);
  const owner = e.definition && ['chip', 'section', 'widget', 'link'].includes(e.element) ? e.definition.key : '';
  return owner ? `${kind} · ${owner}` : kind;
}

/** The access map after the chip, search and filters, grouped by record type, then pages, then app areas. */
export function accessView(
  elements: AccessMapElement[],
  a: AccessAddress,
  ctx: { roles: RoleInfo[]; recordTypes: { key: string; label: string }[]; changed?: ReadonlySet<string>; showRoles?: boolean },
): AccessView {
  // Without `admin:roles` the server sends no role holders, so holders, the "held by" filter and the problems view are left out.
  const showRoles = ctx.showRoles !== false;
  const roleLabels = new Map(ctx.roles.map((r) => [r.key, r.label]));
  const q = a.q.toLowerCase();
  const kinds = a.area === 'all' ? null : CHIP_ELEMENTS[a.area];
  const rows = elements
    .filter(
      (e) =>
        (!kinds || kinds.includes(e.element)) &&
        (!a.recordType || e.recordType === a.recordType || e.area === 'app') &&
        (!showRoles || !a.heldBy || e.permission === null || e.roles.includes(a.heldBy)) &&
        (!q || e.label.toLowerCase().includes(q) || !!e.permission?.toLowerCase().includes(q)),
    )
    .map((e): AccessRow => {
      const id = elementId(e);
      return {
        id,
        element: e,
        label: e.label,
        where: where(e),
        permission: e.permission,
        note: note(e, roleLabels),
        holders: !showRoles
          ? ''
          : e.permission === null && e.element !== 'page'
            ? t('ui.builder.access.everyone')
            : e.roles.map((k) => roleLabels.get(k) ?? k).join(', ') || '—',
        noRole: showRoles && heldByNoRole(e, ctx.roles),
        changed: !!ctx.changed?.has(id),
      };
    })
    .filter((r) => !showRoles || !a.problems || r.noRole);

  const groups: AccessGroup[] = [];
  const push = (id: string, label: string, list: AccessRow[]) => {
    if (list.length) groups.push({ id, label, rows: [...list].sort((x, y) => ORDER.indexOf(x.element.element) - ORDER.indexOf(y.element.element)) });
  };
  for (const type of ctx.recordTypes) push(`type:${type.key}`, type.label, rows.filter((r) => r.element.area === 'records' && r.element.recordType === type.key));
  const known = new Set(ctx.recordTypes.map((x) => x.key));
  push('records', t('ui.builder.access.otherRecords'), rows.filter((r) => r.element.area === 'records' && !known.has(r.element.recordType ?? '')));
  push('pages', t('ui.builder.access.groupPages'), rows.filter((r) => r.element.area === 'pages'));
  push('app', t('ui.builder.access.groupApp'), rows.filter((r) => r.element.area === 'app'));

  const byPermission = new Map<string, string[]>();
  for (const r of rows) if (r.noRole) byPermission.set(r.permission!, [...(byPermission.get(r.permission!) ?? []), r.label]);
  return {
    groups,
    problems: [...byPermission].map(([permission, labels]) => ({ permission, labels })),
    count: rows.length,
  };
}

/** "Chip Closed (Donations)" → "Closed": the element's own name, as the role summary lists it. */
export function elementName(e: Pick<AccessMapElement, 'label'>): string {
  return e.label.replace(/\s\([^()]*\)$/, '').replace(/^(Chip|Section|Step|Action)\s/, '');
}

export interface RoleSummaryItem {
  key: string;
  label: string;
  visible: boolean;
  lines: string[];
}

/** "What can <role> see?" in plain words: per record type, per page, and the app areas. */
export interface RoleSummary {
  records: RoleSummaryItem[];
  pages: RoleSummaryItem[];
  areas: { label: string; on: boolean }[];
}

const TOOLS: [suffix: string, name: string][] = [
  ['import', 'import'],
  ['export', 'export'],
  ['bulk', 'bulk'],
  ['share', 'share'],
  ['read:all', 'seeAll'],
];

export function roleSummary(elements: AccessMapElement[], recordTypes: { key: string; label: string }[]): RoleSummary {
  const names = (list: AccessMapElement[]) => list.map(elementName).join(', ');
  const records = recordTypes.map((type): RoleSummaryItem => {
    const mine = elements.filter((e) => e.area === 'records' && e.recordType === type.key);
    const visible = mine.some((e) => e.element === 'recordType' && e.access === 'see' && e.visible);
    if (!visible) return { key: type.key, label: type.label, visible, lines: [] };
    const can = [
      ...mine.filter((e) => e.element === 'recordType' && e.visible).map((e) => t(`ui.builder.access.can.${e.access}`)),
      ...mine
        .filter((e) => e.element === 'toolbar' && e.visible && e.permission)
        .map((e) => TOOLS.find(([suffix]) => e.permission === `record:${type.key}:${suffix}`)?.[1])
        .filter((x): x is string => !!x)
        .map((x) => t(`ui.builder.access.tool.${x}`)),
    ];
    const hidden = (kind: AccessElementKind, access?: string) => mine.filter((e) => e.element === kind && (!access || e.access === access) && !e.visible);
    const lines = [t('ui.builder.access.view.can', { list: can.join(', ') })];
    const add = (key: string, list: AccessMapElement[]) => list.length && lines.push(t(key, { list: names(list) }));
    add('ui.builder.access.view.masked', hidden('field', 'see'));
    add('ui.builder.access.view.readOnly', hidden('field', 'change'));
    add('ui.builder.access.view.sections', hidden('section'));
    add('ui.builder.access.view.chips', hidden('chip'));
    add('ui.builder.access.view.steps', [...hidden('step'), ...hidden('action')]);
    return { key: type.key, label: type.label, visible, lines };
  });
  const pages = elements
    .filter((e) => e.element === 'page')
    .map((p): RoleSummaryItem => {
      const key = p.definition?.key ?? p.label;
      const parts = elements.filter((e) => (e.element === 'widget' || e.element === 'link') && e.definition?.key === key && !e.visible);
      return { key, label: p.label, visible: !!p.visible, lines: p.visible && parts.length ? [t('ui.builder.access.view.widgets', { list: names(parts) })] : [] };
    });
  const areas = elements.filter((e) => e.element === 'area').map((e) => ({ label: e.label, on: !!e.visible }));
  return { records, pages, areas };
}
