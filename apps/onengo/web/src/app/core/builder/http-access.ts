import { contracted, type CreateRoleRequest, type UpdateRoleRequest } from '../contracts';
import type { HttpLike } from '../http/http';
import type { DefinitionKind } from '../models';

/** A role as the Builder edits it: what it allows, not who has it. */
export interface RoleView {
  key: string;
  label: string;
  permissions: string[];
  requireTwoStep: boolean;
  /** Changed by the organisation, so module updates keep it. */
  customised: boolean;
  members: number;
}

export interface CatalogueGroup {
  key: string;
  label: string;
  kind: 'recordType' | 'money' | 'setup' | 'used';
}

export interface CatalogueEntry {
  permission: string;
  label: string;
  group: string;
}

/** Every permission the role grid can switch, grouped as the server generates them from the definitions. */
export interface PermissionCatalogue {
  groups: CatalogueGroup[];
  entries: CatalogueEntry[];
}

export type AccessArea = 'records' | 'pages' | 'app';
export type AccessElementKind = 'recordType' | 'toolbar' | 'field' | 'chip' | 'section' | 'step' | 'action' | 'page' | 'widget' | 'link' | 'area';

/** One part of a screen, the permission it requires and the roles holding it. */
export interface AccessMapElement {
  area: AccessArea;
  recordType?: string;
  element: AccessElementKind;
  access: 'see' | 'create' | 'change' | 'run' | 'use';
  label: string;
  /** Where the permission is set, for elements defined in a definition. */
  definition?: { kind: DefinitionKind; key: string; path: string };
  /** Null when everyone who reaches the element may use it. */
  permission: string | null;
  /** Written in the definition rather than generated. */
  explicit: boolean;
  overridable: boolean;
  /** Pages only: roles in the audience; empty means everyone. */
  audience?: string[];
  roles: string[];
  warnings: string[];
  /** With a role: whether that role sees or can use the element. */
  visible?: boolean;
}

export interface AccessMap {
  elements: AccessMapElement[];
  role?: { key: string; label: string; summary: string };
}

export interface ModuleRow {
  key: string;
  label: string;
  description: string | null;
  version: string;
  installedVersion: string | null;
  enabled: boolean;
  dependsOn: string[];
  definitions: { kind: DefinitionKind; key: string }[];
  updateAvailable: boolean;
}

/** What updating a module would change, and the organisation's changes that no longer fit. */
export interface ModuleReview {
  key: string;
  label: string;
  installedVersion: string | null;
  version: string;
  enabled: boolean;
  definitions: { kind: DefinitionKind; key: string; status: 'new' | 'changed' | 'unchanged' | 'removed'; patched: boolean; lines: string[] }[];
  conflicts: { kind: DefinitionKind; key: string; path: string; message: string }[];
  canUpdate: boolean;
}

/** Roles, the permission catalogue, the access map and modules. */
export interface AccessGateway {
  roles(): Promise<RoleView[]>;
  role(key: string): Promise<RoleView>;
  createRole(input: CreateRoleRequest): Promise<RoleView>;
  saveRole(key: string, input: UpdateRoleRequest): Promise<RoleView>;
  deleteRole(key: string): Promise<void>;
  permissionCatalogue(): Promise<PermissionCatalogue>;
  accessMap(query?: { role?: string }): Promise<AccessMap>;
  modules(): Promise<ModuleRow[]>;
  /** Turns a module on, or brings it up to the shipped version. */
  enableModule(key: string): Promise<void>;
  disableModule(key: string): Promise<void>;
  moduleUpdate(key: string): Promise<ModuleReview>;
}

const role = (key: string) => `/api/admin/roles/${encodeURIComponent(key)}`;
const mod = (key: string) => `/api/builder/modules/${encodeURIComponent(key)}`;

/** The role routes with fixed contracts. */
export interface RoleRoutes {
  'POST /api/admin/roles': { body: CreateRoleRequest; answer: RoleView };
  'PUT /api/admin/roles/:key': { body: UpdateRoleRequest; answer: RoleView };
}

export function httpAccess(http: HttpLike): AccessGateway {
  const send = contracted<RoleRoutes>(http);
  return {
    roles: () => http.get<RoleView[]>('/api/admin/roles'),
    role: (key) => http.get<RoleView>(role(key)),
    createRole: (input) => send('POST /api/admin/roles', input),
    saveRole: (key, input) => send('PUT /api/admin/roles/:key', { key }, input),
    deleteRole: (key) => http.delete(role(key)),
    permissionCatalogue: () => http.get<PermissionCatalogue>('/api/admin/permission-catalogue'),
    accessMap: (query = {}) => http.get<AccessMap>(`/api/admin/access-map${query.role ? `?role=${encodeURIComponent(query.role)}` : ''}`),
    modules: () => http.get<ModuleRow[]>('/api/builder/modules'),
    enableModule: (key) => http.post(`${mod(key)}/enable`),
    disableModule: (key) => http.post(`${mod(key)}/disable`),
    moduleUpdate: (key) => http.get<ModuleReview>(`${mod(key)}/update`),
  };
}
