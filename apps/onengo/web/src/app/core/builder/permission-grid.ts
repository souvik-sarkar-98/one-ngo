import { permissionMatches } from '../server';
import type { CatalogueEntry, PermissionCatalogue } from './http-access';

/** The per-record-type columns of the grid, in order; each is `record:<type>:<column>`. */
export const GRID_COLUMNS = ['read', 'create', 'update', 'sensitive', 'read:all', 'share', 'import', 'export', 'bulk'] as const;
export type GridColumn = (typeof GRID_COLUMNS)[number];

export interface GridCell {
  permission: string;
  label: string;
  on: boolean;
  /** The broader grant that gives it, such as `record:donation:*`; it cannot be switched off on its own. */
  via: string | null;
}

export interface GridRow {
  /** The record type's key. */
  key: string;
  label: string;
  cells: Partial<Record<GridColumn, GridCell>>;
  steps: GridCell[];
  actions: GridCell[];
  /** Further record type permissions, such as importing without automations. */
  others: GridCell[];
}

export interface PermissionGrid {
  recordTypes: GridRow[];
  money: GridCell[];
  setup: GridCell[];
  /** Permission strings written on chips, steps, actions, sections, fields, widgets and links. */
  used: GridCell[];
  /** Grants the catalogue does not list, such as `*` or `record:donation:*`. */
  extra: string[];
  /** Grid columns any record type has, so columns no type uses are left out. */
  columns: GridColumn[];
}

/** The grant among `permissions` that gives `permission`: itself when held as written, else the first broader one. */
export function grantOf(permissions: readonly string[], permission: string): string | null {
  if (permissions.includes(permission)) return permission;
  return permissions.find((g) => permissionMatches(g, permission)) ?? null;
}

export const holds = (permissions: readonly string[], permission: string): boolean => grantOf(permissions, permission) !== null;

const STEP = /^Step: /;
const ACTION = /^Action: /;

function cell(e: CatalogueEntry, permissions: readonly string[], label = e.label): GridCell {
  const grant = grantOf(permissions, e.permission);
  return { permission: e.permission, label, on: grant !== null, via: grant && grant !== e.permission ? grant : null };
}

/** The role grid drawn from the permission catalogue and what the role holds. */
export function permissionGrid(catalogue: PermissionCatalogue, permissions: readonly string[]): PermissionGrid {
  const inGroup = (key: string) => catalogue.entries.filter((e) => e.group === key);
  const recordTypes = catalogue.groups
    .filter((g) => g.kind === 'recordType')
    .map((g): GridRow => {
      const key = g.key.replace(/^record:/, '');
      const row: GridRow = { key, label: g.label, cells: {}, steps: [], actions: [], others: [] };
      for (const e of inGroup(g.key)) {
        const rest = e.permission.startsWith(`record:${key}:`) ? e.permission.slice(`record:${key}:`.length) : '';
        if ((GRID_COLUMNS as readonly string[]).includes(rest)) row.cells[rest as GridColumn] = cell(e, permissions);
        else if (rest.startsWith('transition:') || STEP.test(e.label)) row.steps.push(cell(e, permissions, e.label.replace(STEP, '')));
        else if (rest.startsWith('action:') || ACTION.test(e.label)) row.actions.push(cell(e, permissions, e.label.replace(ACTION, '')));
        else row.others.push(cell(e, permissions));
      }
      return row;
    });
  const of = (kind: string) =>
    catalogue.groups.filter((g) => g.kind === kind).flatMap((g) => inGroup(g.key).map((e) => cell(e, permissions)));
  const listed = new Set(catalogue.entries.map((e) => e.permission));
  return {
    recordTypes,
    money: of('money'),
    setup: of('setup'),
    used: of('used'),
    extra: permissions.filter((p) => !listed.has(p)),
    columns: GRID_COLUMNS.filter((c) => recordTypes.some((r) => r.cells[c])),
  };
}

/** A role key from its name, as the server accepts them: "Programme staff" → "programme-staff". */
export function roleKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '')
    .slice(0, 41);
}

/** The role's permissions with one switched on or off; switching off removes it as written, never a broader grant. */
export function togglePermission(permissions: readonly string[], permission: string, on: boolean): string[] {
  if (on) return holds(permissions, permission) ? [...permissions] : [...permissions, permission];
  return permissions.filter((p) => p !== permission);
}
