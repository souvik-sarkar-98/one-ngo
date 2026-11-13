import type { ActionDef, DefinitionBodies, DefinitionKind, ListViewDef, PageDef, PublishedDefinition, RecordTypeDef, ReportDef, WorkflowDef } from '../definitions/types.js';
import { permissionMatches } from './permissions.js';
import { actionPermission } from './action-permissions.js';
import { readPermissionOf } from './field-permissions.js';
import { sharingPermissionsByType } from './record-permissions.js';

/** The published definitions that decide who sees what. */
export interface PermissionDefs {
  recordTypes: RecordTypeDef[];
  workflows: WorkflowDef[];
  listViews: ListViewDef[];
  actions: ActionDef[];
  pages: PageDef[];
  /** Each needs `report:<key>:run`. */
  reports?: ReportDef[];
}

/** The permission that runs a report. */
export const reportPermission = (key: string) => `report:${key}:run`;

export type AccessArea = 'records' | 'pages' | 'app';
export type AccessElementKind = 'recordType' | 'toolbar' | 'field' | 'chip' | 'section' | 'step' | 'action' | 'page' | 'widget' | 'link' | 'area';

/** One part of a screen and the permission it needs. */
export interface AccessElement {
  area: AccessArea;
  recordType?: string;
  element: AccessElementKind;
  /** What the permission lets someone do with the element. */
  access: 'see' | 'create' | 'change' | 'run' | 'use';
  label: string;
  /** Where the permission is set, for elements defined in a definition. */
  definition?: { kind: DefinitionKind; key: string; path: string };
  /** Null when everyone who reaches the element may use it. */
  permission: string | null;
  /** The permission string is written in the definition rather than generated. */
  explicit: boolean;
  /** The Builder can set or change the permission. */
  overridable: boolean;
  /** Pages only: roles in the audience; empty means everyone. */
  audience?: string[];
}

/**
 * App areas and the permission each needs; none of them can be changed in the Builder.
 * Labels ending "(API only)" have no screen in the web app yet: the permission
 * only opens the API.
 */
export const APP_AREAS: [string, string][] = [
  ['people:read', 'People list (API only)'],
  ['config:read', 'Builder'],
  ['config:publish', 'Builder: publish changes'],
  ['config:script:publish', 'Builder: publish scripts'],
  ['config:script:admin', 'Builder: scripts and reports that read the ledger or run as a role'],
  ['config:modules', 'Builder: modules'],
  ['admin:roles', 'Administration: roles'],
  ['members:manage', 'Administration: people'],
  ['auth:configure', 'Administration: sign-in providers (API only)'],
  ['admin:connectors', 'Administration: connectors'],
  ['admin:api-keys', 'Administration: API keys'],
  ['admin:jobs', 'Administration: jobs'],
  ['admin:audit', 'Administration: audit log'],
  ['admin:settings', 'Administration: settings'],
  ['data:export', "Export all of the organisation's data (API only)"],
  ['data:migrate', 'Administration: data migration'],
  ['data:migrate:books', 'Administration: data migration opening balances and receipt numbers'],
  ['privacy:consent:read', 'Privacy: consent records (API only)'],
  ['privacy:consent:record', 'Privacy: record consent (API only)'],
  ['privacy:erase', 'Privacy: erase a person (API only)'],
  ['money:accounts:read', 'Money accounts (API only)'],
  ['money:accounts:manage', 'Money accounts: open and change (API only)'],
  ['money:transfer', 'Money: transfers (API only)'],
  ['payments:create', 'Payments: take payments (API only)'],
  ['payments:confirm', 'Payments: confirm (API only)'],
  ['payments:configure', 'Payments: providers (API only)'],
];

type Lister = { list<K extends DefinitionKind>(tenantId: string, kind: K): Promise<PublishedDefinition<K>[]> };

export async function permissionDefs(defs: Lister, tenantId: string): Promise<PermissionDefs> {
  const bodies = async <K extends DefinitionKind>(kind: K) =>
    (await defs.list(tenantId, kind)).sort((a, b) => a.key.localeCompare(b.key)).map((d) => d.body as DefinitionBodies[K]);
  return {
    recordTypes: await bodies('recordType'),
    workflows: await bodies('workflow'),
    listViews: await bodies('listView'),
    actions: await bodies('action'),
    pages: await bodies('page'),
    reports: await bodies('report'),
  };
}

/** Permission strings written in one definition, with where. */
export function explicitPermissions<K extends DefinitionKind>(kind: K, body: DefinitionBodies[K]): { path: string; permission: string }[] {
  const out: { path: string; permission: string }[] = [];
  const add = (path: string, permission: string | undefined) => {
    if (permission) out.push({ path, permission });
  };
  switch (kind) {
    case 'recordType':
      (body as RecordTypeDef).fields.forEach((f, i) => {
        add(`/fields/${i}/readPermission`, f.readPermission);
        add(`/fields/${i}/editPermission`, f.editPermission);
      });
      break;
    case 'workflow':
      (body as WorkflowDef).transitions.forEach((t, i) => add(`/transitions/${i}/permission`, t.permission));
      break;
    case 'action':
      add('/permission', (body as ActionDef).permission);
      break;
    case 'listView': {
      const v = body as ListViewDef;
      v.chips?.forEach((c, i) => add(`/chips/${i}/permission`, c.permission));
      v.detail?.sections.forEach((s, i) => add(`/detail/sections/${i}/permission`, s.permission));
      break;
    }
    case 'page':
      (body as PageDef).widgets.forEach((w, i) => {
        add(`/widgets/${i}/permission`, w.permission);
        if (w.type === 'links') w.items.forEach((l, j) => add(`/widgets/${i}/items/${j}/permission`, l.permission));
      });
      break;
  }
  return out;
}

/** The permissions generated from record types, their workflow steps, record actions and reports. */
export function generatedPermissions(defs: Pick<PermissionDefs, 'recordTypes' | 'workflows' | 'actions' | 'reports'>): Set<string> {
  const out = new Set<string>();
  for (const t of defs.recordTypes) {
    for (const p of ['read', 'create', 'update', 'sensitive', 'import', 'import:quiet', 'export', 'bulk']) out.add(`record:${t.key}:${p}`);
  }
  for (const list of Object.values(sharingPermissionsByType(defs.recordTypes))) for (const s of list) out.add(s.permission);
  for (const w of defs.workflows) for (const t of w.transitions) out.add(`record:${w.recordType}:transition:${t.key}`);
  for (const a of defs.actions) out.add(`record:${a.recordType}:action:${a.key}`);
  for (const r of defs.reports ?? []) out.add(reportPermission(r.key));
  return out;
}

/**
 * Whether a permission is generated, an app permission, or granted by some
 * role. A role granting everything (`*`) does not count: it says nothing
 * about who the permission is meant for.
 */
export function isKnownPermission(permission: string, generated: ReadonlySet<string>, rolePermissions: readonly string[]): boolean {
  if (generated.has(permission) || APP_AREAS.some(([p]) => p === permission)) return true;
  return rolePermissions.some((g) => g !== '*' && permissionMatches(g, permission));
}

/** The elements each permission string written in a definition is used on, sorted by permission. */
export function permissionUses(elements: AccessElement[]): Map<string, AccessElement[]> {
  const out = new Map<string, AccessElement[]>();
  for (const e of elements) {
    if (!e.explicit || !e.permission) continue;
    const list = out.get(e.permission) ?? [];
    list.push(e);
    out.set(e.permission, list);
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** "Used on Section Bank details (Donors), …" for each permission string written in a definition. */
export function usedPermissionLabels(elements: AccessElement[]): Map<string, string> {
  return new Map(
    [...permissionUses(elements)].map(([p, uses]) => {
      const more = uses.length > 3 ? ` and ${uses.length - 3} more` : '';
      return [p, `Used on ${uses.slice(0, 3).map((u) => u.label).join(', ')}${more}`];
    }),
  );
}

/** Every element of the organisation's screens with the permission it needs, by area. */
export function accessElements(defs: PermissionDefs): AccessElement[] {
  const out: AccessElement[] = [];
  const types = new Map(defs.recordTypes.map((t) => [t.key, t]));
  const sharing = sharingPermissionsByType(defs.recordTypes);
  for (const t of defs.recordTypes) {
    const plural = t.pluralLabel ?? t.label;
    const base = { area: 'records' as const, recordType: t.key, explicit: false, overridable: false };
    const at = (path: string) => ({ kind: 'recordType' as const, key: t.key, path });
    out.push({ ...base, element: 'recordType', access: 'see', label: `See ${plural}`, definition: at(''), permission: `record:${t.key}:read` });
    out.push({ ...base, element: 'recordType', access: 'create', label: `Add ${plural}`, definition: at(''), permission: `record:${t.key}:create` });
    out.push({ ...base, element: 'recordType', access: 'change', label: `Edit ${plural}`, definition: at(''), permission: `record:${t.key}:update` });
    for (const [p, label] of [
      ['import', 'Import'],
      ['export', 'Export'],
      ['bulk', 'Select and bulk'],
    ] as const) {
      out.push({ ...base, element: 'toolbar', access: 'use', label: `${label} (${plural})`, permission: `record:${t.key}:${p}` });
    }
    for (const s of sharing[t.key] ?? []) {
      out.push({ ...base, element: 'toolbar', access: 'use', label: `${s.key === 'share' ? 'Share' : 'See all'} (${plural})`, permission: s.permission });
    }
    t.fields.forEach((f, i) => {
      out.push({
        ...base,
        element: 'field',
        access: 'see',
        label: `${f.label} (${t.label})`,
        definition: at(`/fields/${i}/readPermission`),
        permission: readPermissionOf(t, f) ?? `record:${t.key}:read`,
        explicit: !!f.readPermission,
        overridable: true,
      });
      if (f.calculated || f.rollup) return;
      out.push({
        ...base,
        element: 'field',
        access: 'change',
        label: `${f.label} (${t.label})`,
        definition: at(`/fields/${i}/editPermission`),
        permission: f.editPermission ?? `record:${t.key}:update`,
        explicit: !!f.editPermission,
        overridable: true,
      });
    });
    for (const v of defs.listViews.filter((x) => x.recordType === t.key)) {
      const lv = (path: string) => ({ kind: 'listView' as const, key: v.key, path });
      v.chips?.forEach((c, i) =>
        out.push({
          ...base,
          element: 'chip',
          access: 'see',
          label: `Chip ${c.label} (${plural})`,
          definition: lv(`/chips/${i}/permission`),
          permission: c.permission ?? `record:${t.key}:read`,
          explicit: !!c.permission,
          overridable: true,
        }),
      );
      v.detail?.sections.forEach((s, i) =>
        out.push({
          ...base,
          element: 'section',
          access: 'see',
          label: `Section ${s.label} (${plural})`,
          definition: lv(`/detail/sections/${i}/permission`),
          permission: s.permission ?? ('related' in s ? `record:${s.related.recordType}:read` : `record:${t.key}:read`),
          explicit: !!s.permission,
          overridable: true,
        }),
      );
    }
    for (const w of defs.workflows.filter((x) => x.recordType === t.key)) {
      w.transitions.forEach((s, i) =>
        out.push({
          ...base,
          element: 'step',
          access: 'run',
          label: `Step ${s.label} (${plural})`,
          definition: { kind: 'workflow', key: w.key, path: `/transitions/${i}/permission` },
          permission: s.permission ?? `record:${t.key}:transition:${s.key}`,
          explicit: !!s.permission,
          overridable: true,
        }),
      );
    }
    for (const a of defs.actions.filter((x) => x.recordType === t.key)) {
      out.push({
        ...base,
        element: 'action',
        access: 'run',
        label: `Action ${a.label} (${plural})`,
        definition: { kind: 'action', key: a.key, path: '/permission' },
        permission: actionPermission(a),
        explicit: !!a.permission,
        overridable: true,
      });
    }
  }

  const listTypes = new Map(defs.listViews.map((v) => [v.key, v.recordType]));
  for (const p of defs.pages) {
    const pg = (path: string) => ({ kind: 'page' as const, key: p.key, path });
    out.push({ area: 'pages', element: 'page', access: 'see', label: p.label, definition: pg('/audience'), permission: null, explicit: false, overridable: false, audience: p.audience ?? [] });
    p.widgets.forEach((w, i) => {
      const recordType = w.type === 'stat' || w.type === 'chart' ? w.recordType : w.type === 'list' ? listTypes.get(w.listView) : undefined;
      const label = 'label' in w ? w.label : 'Record groups';
      out.push({
        area: 'pages',
        ...(recordType && types.has(recordType) ? { recordType } : {}),
        element: 'widget',
        access: 'see',
        label: `${label} (${p.label})`,
        definition: pg(`/widgets/${i}/permission`),
        permission: w.permission ?? (recordType ? `record:${recordType}:read` : null),
        explicit: !!w.permission,
        overridable: true,
      });
      if (w.type !== 'links') return;
      w.items.forEach((l, j) =>
        out.push({
          area: 'pages',
          element: 'link',
          access: 'see',
          label: `${l.label} (${p.label})`,
          definition: pg(`/widgets/${i}/items/${j}/permission`),
          permission: l.permission ?? null,
          explicit: !!l.permission,
          overridable: true,
        }),
      );
    });
  }

  for (const [permission, label] of APP_AREAS) {
    out.push({ area: 'app', element: 'area', access: 'use', label, permission, explicit: false, overridable: false });
  }
  for (const r of defs.reports ?? []) {
    out.push({
      area: 'app',
      element: 'area',
      access: 'run',
      label: `Report: ${r.label}`,
      definition: { kind: 'report', key: r.key, path: '' },
      permission: reportPermission(r.key),
      explicit: false,
      overridable: false,
    });
  }
  return out;
}
