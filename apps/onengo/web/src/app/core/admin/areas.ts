import { t } from '../i18n/i18n';
import type { Me } from '../models';

export type AdminAreaId =
  | 'people'
  | 'roles'
  | 'connectors'
  | 'apiKeys'
  | 'jobs'
  | 'audit'
  | 'settings'
  | 'theme'
  | 'layout'
  | 'identity'
  | 'profile'
  | 'registrations'
  | 'migration';

export interface AdminArea {
  id: AdminAreaId;
  label: string;
  hint: string;
  link: string;
}

/** Administration's home. Theme and layout are the Builder's; a role's permissions are a tab on the role. */
export interface AdminHome {
  organisation: AdminArea[];
  people: AdminArea[];
  integrations: AdminArea[];
  data: AdminArea[];
  activity: AdminArea[];
}

type Capabilities = Me['capabilities'] | undefined;

const LINKS: Record<AdminAreaId, string> = {
  people: '/admin/people',
  roles: '/admin/roles',
  connectors: '/admin/connectors',
  apiKeys: '/admin/api-keys',
  jobs: '/admin/jobs',
  audit: '/admin/audit',
  settings: '/admin/organisation/settings',
  theme: '/builder/theme',
  layout: '/builder/layout',
  identity: '/admin/organisation/identity',
  profile: '/admin/organisation/profile',
  registrations: '/admin/organisation/registrations',
  migration: '/admin/migration',
};

const SETTINGS_AREAS = new Set<AdminAreaId>(['settings', 'theme', 'layout', 'identity', 'profile', 'registrations']);

/** Administration's home groups, in the order the home shows them. Each organisation group is one table's screen. */
export const ADMIN_GROUPS: { id: string; labelKey: string; areas: readonly AdminAreaId[] }[] = [
  { id: 'organisation', labelKey: 'ui.admin.organisation', areas: ['identity', 'profile', 'registrations', 'settings'] },
  { id: 'people', labelKey: 'ui.admin.people', areas: ['people', 'roles'] },
  { id: 'integrations', labelKey: 'ui.admin.integrations', areas: ['connectors', 'apiKeys'] },
  { id: 'data', labelKey: 'ui.admin.data', areas: ['migration'] },
  { id: 'activity', labelKey: 'ui.admin.activity', areas: ['jobs', 'audit'] },
];

/** The home group a screen belongs to, when the directory has one. */
export function adminGroupOf(area: AdminAreaId): { id: string; labelKey: string } | undefined {
  const group = ADMIN_GROUPS.find((item) => item.areas.includes(area));
  return group ? { id: group.id, labelKey: group.labelKey } : undefined;
}

/** Whether the person may open an area. Roles is open to people who manage people or roles. */
export function mayOpen(area: AdminAreaId, c: Capabilities): boolean {
  if (!c) return false;
  if (area === 'roles') return !!(c.roles || c.people);
  if (SETTINGS_AREAS.has(area)) return !!c.settings;
  if (area === 'people' || area === 'connectors' || area === 'apiKeys' || area === 'jobs' || area === 'audit' || area === 'migration') return !!c[area];
  return false;
}

/**
 * Whether the person may publish the organisation's theme or layout. The server accepts
 * `admin:settings` or `config:publish` for both (`settings` or `publish` here).
 */
export function mayPublishLook(c: Capabilities): boolean {
  return !!c && !!(c.publish || c.settings);
}

/** The Builder screens that Administration also opens, so `admin:settings` alone is enough for them. */
const LOOK_PATHS = ['/builder/theme', '/builder/layout'];

/**
 * Whether the person may open this Builder address. The Builder needs `config:read`; Theme and Layout also
 * open with `admin:settings` (the same rule as `mayOpen` for those areas). Nothing else in the Builder does.
 */
export function mayOpenBuilder(url: string, c: Capabilities): boolean {
  if (!c) return false;
  if (c.configure) return true;
  const path = (url.split(/[?#]/)[0] ?? '').replace(/\/+$/, '');
  return !!c.settings && LOOK_PATHS.includes(path);
}

function area(id: AdminAreaId): AdminArea {
  const label = id === 'jobs' ? t('ui.admin.jobs') : t(`ui.crumbs.admin.${id}`);
  const hint = id === 'roles' ? t('ui.admin.hint.rolesSummary') : t(`ui.admin.hint.${id}`);
  return { id, label, hint, link: LINKS[id] };
}

/** Administration's home: only the areas the person's capabilities allow. */
export function adminHome(c: Capabilities): AdminHome {
  const allowed = (ids: readonly AdminAreaId[]) => ids.filter((id) => mayOpen(id, c)).map(area);
  const listed = (id: string) => allowed(ADMIN_GROUPS.find((group) => group.id === id)?.areas ?? []);
  return {
    organisation: listed('organisation'),
    people: listed('people'),
    integrations: listed('integrations'),
    data: listed('data'),
    activity: listed('activity'),
  };
}
