import type { TenantContext } from '../../../domain/ports/tenant-context.js';
import type { AppearanceLayout } from '../../../runtime/definitions/appearance.js';
import type { DefinitionKind, PublishedDefinition, ThemeDef } from '../../../runtime/definitions/types.js';
import type { AuditEntry, AuditQuery, OrganisationSettings, SettingsInput } from '../../administration/administration-service.js';
import type { ConnectorSummary, ConnectorTestResult, ConnectorUser, ConnectorView, Delivery, SaveConnectorInput } from '../../connectors/connector-service.js';
import type { AccessMap, AccessMapQuery, PermissionSuggestion } from '../../identity/access-service.js';
import type { ApiKeyFeedChoice, ApiKeyView } from '../../identity/api-key-service.js';
import type { AddMemberInput, DirectoryPage, DirectoryQuery, MemberListQuery, MemberPage, MemberView, PersonOption, RoleOption } from '../../identity/people-service.js';
import type { PermissionCatalogue, RoleInput, RoleView } from '../../identity/roles-service.js';

/** What the admin routes ask of roles, people, audit, settings, API keys and connectors. Each service satisfies the part it is given. */

/** Reads and edits roles and the permission catalogue. */
export interface RoleAdmin {
  list(ctx: TenantContext): Promise<RoleView[]>;
  create(ctx: TenantContext, input: RoleInput): Promise<RoleView>;
  get(ctx: TenantContext, key: string): Promise<RoleView>;
  update(ctx: TenantContext, key: string, input: RoleInput): Promise<RoleView>;
  remove(ctx: TenantContext, key: string): Promise<void>;
  catalogue(ctx: TenantContext): Promise<PermissionCatalogue>;
}

/** Replaces the roles a member holds. */
export interface MemberRoleAssignment {
  setMemberRoles(ctx: TenantContext, userId: string, input: { roles?: unknown }): Promise<void>;
}

/** Permission suggestions and who can reach what. */
export interface AccessReports {
  suggestions(ctx: TenantContext, q?: string): Promise<PermissionSuggestion[]>;
  accessMap(ctx: TenantContext, query?: AccessMapQuery): Promise<AccessMap>;
}

/** The member list, invitations, suspension, pickers, the directory and role membership. */
export interface PeopleAdmin {
  list(ctx: TenantContext, query?: MemberListQuery): Promise<MemberPage>;
  add(ctx: TenantContext, input: AddMemberInput): Promise<{ userId: string; email: string; displayName: string; invited: boolean }>;
  member(ctx: TenantContext, userId: string): Promise<MemberView>;
  invite(ctx: TenantContext, userId: string): Promise<void>;
  suspend(ctx: TenantContext, userId: string): Promise<MemberView>;
  reactivate(ctx: TenantContext, userId: string): Promise<MemberView>;
  pick(ctx: TenantContext, query: { q?: unknown; limit?: unknown }): Promise<{ items: PersonOption[] }>;
  directory(ctx: TenantContext, query?: DirectoryQuery): Promise<DirectoryPage>;
  roleMembers(ctx: TenantContext, key: string, query?: MemberListQuery): Promise<MemberPage & { role: RoleOption }>;
  addRoleMembers(ctx: TenantContext, key: string, input: { userIds?: unknown }): Promise<MemberPage & { role: RoleOption }>;
  removeRoleMember(ctx: TenantContext, key: string, userId: string): Promise<void>;
}

/** One member as they are now. */
export interface MemberLookup {
  member(ctx: TenantContext, userId: string): Promise<MemberView>;
}

/** The audit trail and the organisation's settings. */
export interface AuditAndSettings {
  audit(ctx: TenantContext, query?: AuditQuery): Promise<{ items: AuditEntry[]; total: number; limit: number; offset: number }>;
  settings(ctx: TenantContext): Promise<OrganisationSettings>;
  saveSettings(ctx: TenantContext, input: SettingsInput): Promise<OrganisationSettings>;
  saveTheme(ctx: TenantContext, body: unknown): Promise<ThemeDef>;
  layout(ctx: TenantContext): Promise<{ items: string[] | null; listLayout: 'cards' | 'table'; icons: Record<string, string> | null }>;
  saveLayout(ctx: TenantContext, body: unknown): Promise<AppearanceLayout>;
}

/** API keys: list, create (the token shows once) and revoke. */
export interface ApiKeyAdmin {
  list(ctx: TenantContext): Promise<ApiKeyView[]>;
  /** Published data feeds a new key can be bound to. */
  feeds(ctx: TenantContext): Promise<ApiKeyFeedChoice[]>;
  create(ctx: TenantContext, input: { name?: unknown; role?: unknown; feed?: unknown }): Promise<ApiKeyView & { token: string }>;
  revoke(ctx: TenantContext, id: string): Promise<void>;
}

/** One connector: read, save, test and its deliveries. */
export interface ConnectorAdmin {
  retry(ctx: TenantContext, key: string, deliveryId: string): Promise<void>;
  get(ctx: TenantContext, key: string): Promise<ConnectorView>;
  save(ctx: TenantContext, key: string, input: SaveConnectorInput): Promise<ConnectorView>;
  test(ctx: TenantContext, key: string, input?: { to?: unknown; inputs?: unknown }): Promise<ConnectorTestResult>;
  deliveries(ctx: TenantContext, key: string, options?: { limit?: number; offset?: number }): Promise<Delivery[]>;
}

/** Every connector with the definitions that send through it. */
export interface ConnectorCatalogue {
  list(ctx: TenantContext, users: ConnectorUser[]): Promise<ConnectorSummary[]>;
}

/** The published definitions of one kind. */
export interface PublishedDefinitions {
  list<K extends DefinitionKind>(tenantId: string, kind: K): Promise<PublishedDefinition<K>[]>;
}
