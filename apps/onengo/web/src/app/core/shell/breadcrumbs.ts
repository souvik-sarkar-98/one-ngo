import { builderTrail, type Crumb } from '../builder/crumbs';
import { builderPlace } from '../builder/catalogue';
import { adminGroupOf, type AdminAreaId } from '../admin/areas';
import { lowerLabel, t } from '../i18n/i18n';
import { DEFINITION_KINDS, type DefinitionKind, type RuntimeDefinitions } from '../models';
import { groupOf, isBare, plural } from './shell';
import { directoryTrail, type TrailStep } from '@onengo/web-kit';

export type { Crumb };

/** What only the screen knows, supplied through ScreenMeta once its data has loaded. */
export interface CrumbLabels {
  /**
   * The last item's label, replacing the one worked out from the address (an
   * Inbox tab, a page title). In a Builder editor it is the selection or tab,
   * added after the definition.
   */
  last?: string | null;
  /** Labels of items before the last, by name: `record`, `definition`, `person`, `role`, `connector`, `job`, `file`, `locale`, `report`, `reportGroup`. */
  named?: Readonly<Record<string, string>>;
}

type Params = Readonly<Record<string, string>>;
type Named = Readonly<Record<string, string>>;

/** Parameters that belong to the open record or a panel rather than to the list. */
const NOT_LIST = ['id', 'panel', 'create', 'createStep', 'import', 'importStep', 'importId', 'job', 'filters'];
const NOT_RECORD = ['panel', 'import', 'importStep', 'importId', 'job', 'filters'];
const ADMIN_AREAS: Record<string, string> = {
  people: 'people',
  roles: 'roles',
  connectors: 'connectors',
  'api-keys': 'apiKeys',
  jobs: 'jobs',
  audit: 'audit',
  settings: 'settings',
  theme: 'theme',
  layout: 'layout',
  migration: 'migration',
};
const KINDS = new Set<string>(DEFINITION_KINDS);

function query(params: Params, drop: string[]): string {
  const kept = Object.entries(params).filter(([k]) => !drop.includes(k));
  return kept.length ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
}

function panelLabel(panel: string | undefined, type: string, defs: RuntimeDefinitions | null, named: Named): string | null {
  if (!panel) return null;
  if (panel === 'edit') return t('ui.common.edit');
  if (panel === 'share') return t('ui.crumbs.share');
  if (panel.startsWith('file:')) return named['file'] ?? t('ui.crumbs.file');
  if (panel.startsWith('step:')) {
    const key = panel.slice(5);
    const workflows = defs?.workflowSets?.[type] ?? (defs?.workflows[type] ? [defs.workflows[type]] : []);
    return workflows.flatMap((w) => w.transitions).find((s) => s.key === key)?.label ?? null;
  }
  if (panel.startsWith('action:')) return defs?.actions?.[type]?.find((a) => a.key === panel.slice(7))?.label ?? null;
  return null;
}

function records(parts: string[], params: Params, defs: RuntimeDefinitions | null, named: Named): Crumb[] {
  const key = parts[1];
  if (!key) return directoryTrail({ label: t('ui.nav.records') }, null, []);
  const type = defs?.recordTypes.find((x) => x.key === key);
  const group = groupOf(defs, key);
  const base = `/records/${encodeURIComponent(key)}`;
  const id = params['id'] ?? (parts[2] && parts[2] !== 'new' ? parts[2] : undefined);
  const create = !id && (params['create'] ?? (parts[2] === 'new' ? 'new' : undefined));
  const presets = create ? (defs?.listViews?.[key]?.create?.presets ?? []).map((p) => p.param) : [];
  const rest: TrailStep[] = [{ label: type ? plural(type) : key, href: base + query(params, [...NOT_LIST, ...presets]) }];
  if (id) {
    rest.push({ label: named['record'] ?? t('ui.crumbs.record'), href: base + query({ ...params, id }, NOT_RECORD) });
    const mode = panelLabel(params['panel'], key, defs, named);
    if (mode) rest.push({ label: mode });
  } else if (create) rest.push({ label: t('ui.records.new', { type: lowerLabel(type?.label ?? key) }) });
  if ('import' in params) rest.push({ label: t('ui.crumbs.import') });
  if (params['job']) rest.push({ label: t('ui.crumbs.jobResult') });
  return directoryTrail(
    { label: t('ui.nav.records'), href: '/records' },
    { label: group.label, href: `/records#group-${encodeURIComponent(group.key)}` },
    rest,
  );
}

/** Reports, the report's group, the report, then New while its parameter panel is open. */
function reports(parts: string[], params: Params, named: Named): Crumb[] {
  const key = parts[1];
  if (!key) return directoryTrail({ label: t('ui.nav.reports') }, null, []);
  const label = named['report'] ?? key;
  const rest: TrailStep[] = [{ label, href: `/reports/${encodeURIComponent(key)}` }];
  if (params['create']) rest.push({ label: t('ui.reports.newNamed', { report: label.toLowerCase() }) });
  return directoryTrail({ label: t('ui.nav.reports'), href: '/reports' }, named['reportGroup'] ? { label: named['reportGroup'], href: '/reports' } : null, rest);
}

function inbox(params: Params): Crumb[] {
  return directoryTrail({ label: t('ui.nav.inbox'), href: '/inbox' }, null, [
    { label: t(params['tab'] === 'notifications' ? 'ui.inbox.notifications' : 'ui.inbox.approvals') },
  ]);
}

function settingsCrumb(params: Params): Crumb[] {
  const panel = params['panel'] === 'language' ? t('ui.crumbs.language') : params['panel'] === 'about' ? t('ui.more.about') : null;
  return directoryTrail({ label: t('ui.nav.settings'), href: panel ? '/settings' : undefined }, null, panel ? [{ label: panel }] : []);
}

function page(key: string | undefined, defs: RuntimeDefinitions | null): Crumb[] {
  const p = defs?.pages?.find((x) => x.key === key);
  return directoryTrail(p?.key === 'home' ? { label: t('ui.nav.home'), href: '/' } : { label: p?.label ?? key ?? '' }, null, []);
}

function admin(parts: string[], params: Params, named: Named): Crumb[] {
  const area = parts[1];
  if (!area) return directoryTrail({ label: t('ui.crumbs.administration') }, null, []);
  if (area === 'organisation') {
    const section = parts[2];
    if (section === 'identity' || section === 'profile' || section === 'registrations' || section === 'settings') return adminSteps(section, undefined, []);
    return directoryTrail({ label: t('ui.crumbs.administration'), href: '/admin' }, null, []);
  }
  const areaId = ADMIN_AREAS[area];
  if (!areaId) return directoryTrail({ label: t('ui.crumbs.administration'), href: '/admin' }, null, []);
  const pageHref = `/admin/${area}${query(params, ['person', 'add', 'create', 'job', 'result'])}`;
  const tail: TrailStep[] = [];
  const item = parts[2];
  if (area === 'people' && params['person']) tail.push({ label: named['person'] ?? t('ui.crumbs.person') });
  if (area === 'people' && 'add' in params) tail.push({ label: t('ui.crumbs.addPerson') });
  if (area === 'roles' && item) tail.push({ label: named['role'] ?? item, href: `/admin/roles/${encodeURIComponent(item)}` });
  if (area === 'roles' && 'add' in params) tail.push({ label: t('ui.crumbs.addPeople') });
  if (area === 'connectors' && item) tail.push({ label: named['connector'] ?? item });
  if (area === 'connectors' && !item && 'create' in params) tail.push({ label: t('ui.admin.connectors.new') });
  if (area === 'api-keys' && 'create' in params) tail.push({ label: t('ui.crumbs.newApiKey') });
  if (area === 'jobs' && params['job']) tail.push({ label: named['job'] ?? t('ui.crumbs.job') });
  if (area === 'migration' && item) {
    const step = parts[3];
    tail.push({ label: named['migration'] ?? t('ui.crumbs.migration'), ...(step ? { href: `/admin/migration/${encodeURIComponent(item)}/files` } : {}) });
    if (step) tail.push({ label: t(`ui.crumbs.migrationStep.${step}`) });
  }
  return adminSteps(areaId as AdminAreaId, pageHref, tail);
}

/** One Administration screen: the destination, its home group, the page, then the open item. */
function adminSteps(area: AdminAreaId, pageHref: string | undefined, tail: TrailStep[]): Crumb[] {
  const group = adminGroupOf(area);
  const label = area === 'jobs' ? t('ui.admin.jobs') : t(`ui.crumbs.admin.${area}`);
  return directoryTrail(
    { label: t('ui.crumbs.administration'), href: '/admin' },
    group ? { label: t(group.labelKey), href: `/admin#admin-${group.id}` } : null,
    [{ label, ...(pageHref ? { href: pageHref } : {}) }, ...tail],
  );
}

function builder(parts: string[], params: Params, named: Named, last: string | null): Crumb[] {
  return builderSection(parts, params, named, last);
}

function builderSection(parts: string[], params: Params, named: Named, last: string | null): Crumb[] {
  const [, section, key] = parts;
  const destination = { label: t('ui.builder.title'), href: '/builder' };
  if (!section) {
    const kind = params['kind'];
    return builderTrail(kind && KINDS.has(kind) ? (kind as DefinitionKind) : undefined);
  }
  if (section === 'roles') {
    const rest: TrailStep[] = [{ label: t('ui.crumbs.builder.roles'), href: '/builder/roles' }];
    if (key) rest.push({ label: named['definition'] ?? key, href: `/builder/roles/${encodeURIComponent(key)}` });
    if (last) rest.push({ label: last });
    return directoryTrail(destination, null, rest);
  }
  if (KINDS.has(section) && key) return builderTrail(section as DefinitionKind, key, named['definition'], last);
  const place = builderPlace(section);
  if (place) {
    const rest: TrailStep[] = [{ label: t(place.row.labelKey), href: place.row.href }];
    if (section === 'access' && params['role']) rest.push({ label: named['role'] ?? params['role'] });
    if (section === 'translations' && params['locale']) rest.push({ label: named['locale'] ?? params['locale'] });
    if (last) rest.push({ label: last });
    return directoryTrail(destination, { label: t(place.group.labelKey), href: `/builder#builder-${place.group.id}` }, rest);
  }
  return directoryTrail({ label: t('ui.builder.title') }, null, []);
}

/**
 * The breadcrumb for a route. `directoryTrail` in the web kit places the
 * destination, then the directory group, then the page. This function only
 * names those steps. Every item but the last links; going back to a list
 * keeps the list's own parameters. Empty where the shell draws no breadcrumb.
 */
export function trail(path: string, params: Params, defs: RuntimeDefinitions | null, labels: CrumbLabels = {}): Crumb[] {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const named = labels.named ?? {};
  const last = labels.last || null;
  if (isBare(parts.join('/'))) return [];
  let out: Crumb[];
  let screenSetsLast = true;
  switch (parts[0]) {
    case undefined:
      out = directoryTrail({ label: t('ui.nav.home') }, null, []);
      break;
    case 'records':
      out = records(parts, params, defs, named);
      break;
    case 'inbox':
      out = inbox(params);
      break;
    case 'reports':
      out = reports(parts, params, named);
      break;
    case 'settings':
      out = settingsCrumb(params);
      break;
    case 'pages':
      out = page(parts[1], defs);
      break;
    case 'admin':
      out = admin(parts, params, named);
      break;
    case 'builder':
      out = builder(parts, params, named, last);
      screenSetsLast = false;
      break;
    case 'guide':
      out = directoryTrail({ label: t('ui.guide.title') }, null, []);
      break;
    default:
      return [];
  }
  const end = out.length - 1;
  return out.map((c, i) => (i < end ? c : { label: screenSetsLast && last ? last : c.label }));
}
