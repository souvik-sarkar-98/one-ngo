import { isIconName } from '@onengo/platform/icons';
import { t } from '../i18n/i18n';
import { permissionMatches } from '../server';
import type { Me, RuntimeDefinitions, RuntimeRecordType } from '../models';

export type Destination = 'home' | 'records' | 'inbox' | 'more';

/** One destination as the bottom bar, the rail, or a More tile draw it. */
export interface NavEntry {
  key: string;
  label: string;
  /** An icon name. Known shell marks are drawn directly; other names use the icon font. */
  icon: string;
  link: string;
  badge?: number;
  /** More opens the menu instead of following `link`. */
  menu?: boolean;
  /** Runs a shell command instead of following `link`. */
  command?: string;
}

/**
 * The published navigation. Keys are `home`, `records`, `inbox`, `reports`,
 * `admin`, `builder`, `guide`, `settings`, `signout`, `record:<type>` or `page:<key>`. Absent,
 * the order is Home, Records, Inbox and Reports, then pages,
 * Administration, Builder, the user guide and Settings. More is added only when they overflow.
 */
export interface RuntimeNavigation {
  items: string[];
}

/** A route as the shell reads it: the path without slashes at either end, and the query parameters. */
export interface ShellRoute {
  path: string;
  params: Record<string, string>;
}

/** Routes drawn without the shell's chrome: no app bar, navigation or breadcrumb. */
const BARE = ['sign-in', 'reset-password', 'print', 'o', 'r'];

export const BADGE_REFRESH_MS = 60_000;

export function shellRoute(url: string): ShellRoute {
  const [beforeHash = ''] = url.split('#');
  const [path = '', query = ''] = beforeHash.split('?');
  const params: Record<string, string> = {};
  new URLSearchParams(query).forEach((v, k) => (params[k] ??= v));
  return { path: path.replace(/^\/+|\/+$/g, ''), params };
}

const first = (path: string) => path.split('/')[0] ?? '';

export const isBare = (path: string): boolean => BARE.includes(first(path));

/** Home, Records or Inbox. Other screens match their own nav key. */
export function activeDestination(path: string): Destination | null {
  const top = first(path);
  if (isBare(path)) return null;
  if (!top) return 'home';
  if (top === 'records' || top === 'inbox') return top;
  return null;
}

/** Every default destination on a rail tall enough to show them. Only Inbox carries a badge. */
export function navEntries(badge: number): NavEntry[] {
  return navFor(navigationLayout(null, null, badge), Number.POSITIVE_INFINITY).items;
}

/** The app bar shows a back arrow everywhere except on the destinations themselves. */
export const isTopLevel = (path: string): boolean => ['', 'records', 'inbox', 'reports'].includes(path);

/** Slots on the phone bar. More takes the last one when the links do not fit. */
export const PHONE_SLOTS = 4;
/** App bar height, matching the shell. */
export const APP_BAR_PX = 56;
/** One rail icon as drawn: 57px tall, then the 4px gap. The rail has 10px of padding at the top. */
export const RAIL_ITEM_PX = 57;
export const RAIL_GAP_PX = 4;
export const RAIL_PAD_PX = 10;

/** How many standard-size rail icons fit in this window. Icons are not shrunk to make room. */
export function railCapacity(viewportHeight: number): number {
  const available = Math.max(0, viewportHeight - APP_BAR_PX - RAIL_PAD_PX);
  const slot = RAIL_ITEM_PX + RAIL_GAP_PX;
  if (available < RAIL_ITEM_PX) return 0;
  return Math.floor((available + RAIL_GAP_PX) / slot);
}

export interface ShellNav {
  /** Destinations in the published order. More is added later, only for what does not fit. */
  items: NavEntry[];
}

const MORE_ENTRY = (): NavEntry => ({ key: 'more', label: t('ui.nav.more'), icon: 'more', link: '', menu: true });

/** The icon a destination uses when nobody has chosen one. */
export function defaultNavIcon(key: string): string {
  if (key === 'home' || key.startsWith('page:')) return 'home';
  if (key === 'inbox') return 'inbox';
  if (key === 'reports') return 'assessment';
  if (key === 'guide') return 'menu_book';
  if (key === 'admin') return 'admin_panel_settings';
  if (key === 'builder') return 'build';
  if (key === 'settings') return 'settings';
  if (key === 'signout') return 'logout';
  return 'records';
}

/** A published icon when it is one this app draws, otherwise the destination's own. */
export function navIcon(key: string, icons?: Partial<Record<string, string>>): string {
  const picked = icons?.[key];
  return picked && isIconName(picked) ? picked : defaultNavIcon(key);
}

/**
 * Whether any grant in the person's permissions could run a report: `*`, `report:*`, `report:*:run`
 * or `report:<key>:run`. The shell already holds `permissions` from the session, so no request is needed.
 * It cannot see a report's role audience or whether any report is published; the Reports screen says so
 * when its list is empty.
 */
export function canRunReports(permissions: readonly string[] | undefined): boolean {
  return (permissions ?? []).some((granted) => {
    const key = granted.split(':')[1];
    return permissionMatches(granted, `report:${key && key !== '*' ? key : 'any'}:run`);
  });
}

function navTarget(key: string, me: Me | null, defs: RuntimeDefinitions | null, badge: number, icons?: Partial<Record<string, string>>): NavEntry | null {
  const caps = me?.capabilities;
  const icon = navIcon(key, icons);
  if (key === 'home') return { key, label: t('ui.nav.home'), icon, link: '/' };
  if (key === 'records') return { key, label: t('ui.nav.records'), icon, link: '/records' };
  if (key === 'inbox') return { key, label: t('ui.nav.inbox'), icon, link: '/inbox', ...(badge > 0 ? { badge } : {}) };
  if (key === 'reports') return !me || canRunReports(me.permissions) ? { key, label: t('ui.nav.reports'), icon, link: '/reports' } : null;
  if (key === 'admin') return hasAdministration(caps) ? { key, label: t('ui.crumbs.administration'), icon, link: '/admin' } : null;
  if (key === 'builder') return caps?.configure ? { key, label: t('ui.builder.title'), icon, link: '/builder' } : null;
  if (key === 'guide') return { key, label: t('ui.nav.guide'), icon, link: '/guide' };
  if (key === 'settings') return { key, label: t('ui.nav.settings'), icon, link: '/settings' };
  if (key === 'signout') return { key, label: t('ui.shell.signOut'), icon, link: '', command: 'sign-out' };
  if (key.startsWith('record:')) {
    const type = defs?.recordTypes.find((x) => x.key === key.slice(7));
    return type ? { key, label: plural(type), icon, link: `/records/${encodeURIComponent(type.key)}` } : null;
  }
  if (key.startsWith('page:')) {
    const page = defs?.pages?.find((p) => p.key === key.slice(5));
    return page ? { key, label: page.label, icon, link: `/pages/${encodeURIComponent(page.key)}` } : null;
  }
  return null;
}

/** The order before an organisation publishes its own: Home, Records, Inbox, Reports, other pages, then Administration, Builder, the user guide, Settings and Sign out. */
export function defaultNavigationKeys(me: Me | null, defs: RuntimeDefinitions | null): string[] {
  const keys = ['home', 'records', 'inbox', 'reports'];
  for (const page of defs?.pages ?? []) if (page.key !== 'home') keys.push(`page:${page.key}`);
  if (hasAdministration(me?.capabilities)) keys.push('admin');
  if (me?.capabilities.configure) keys.push('builder');
  keys.push('guide', 'settings', 'signout');
  return keys;
}

/** Sign out stays in the order. A published layout that predates it gets it at the end. */
function withSignOut(items: string[]): string[] {
  return items.includes('signout') ? items : [...items, 'signout'];
}

/** The user guide stays in the order, beside Settings, or just before Sign out when Settings is absent. */
function withGuide(items: string[]): string[] {
  if (items.includes('guide')) return items;
  const settings = items.indexOf('settings');
  const before = settings >= 0 ? settings : items.indexOf('signout');
  if (before < 0) return [...items, 'guide'];
  return [...items.slice(0, before), 'guide', ...items.slice(before)];
}

/** The published order for this person. Items they cannot see are left out. */
export function navigationLayout(me: Me | null, defs: RuntimeDefinitions | null, badge: number): ShellNav {
  const spec = defs?.navigation;
  const keys = withGuide(withSignOut(spec?.items.length ? spec.items : defaultNavigationKeys(me, defs)));
  const icons = spec?.icons;
  const seen = new Set<string>();
  const items = keys
    .map((key) => {
      if (seen.has(key)) return null;
      const item = navTarget(key, me, defs, badge, icons);
      if (!item) return null;
      seen.add(key);
      return item;
    })
    .filter((x): x is NavEntry => !!x);
  return { items };
}

/** Shows every link when `capacity` can hold them. Otherwise the last slot is More and the rest open from it, in order. */
export function placeNav(entries: NavEntry[], capacity: number): { items: NavEntry[]; more: NavEntry[] } {
  const slots = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : entries.length;
  if (entries.length <= slots) return { items: entries, more: [] };
  const shown = entries.slice(0, Math.max(slots - 1, 0));
  return { items: [...shown, MORE_ENTRY()], more: entries.slice(shown.length) };
}

/** The bar or the rail for this capacity, and the links More opens. */
export function navFor(layout: ShellNav, capacity: number): { items: NavEntry[]; more: NavEntry[] } {
  return placeNav(layout.items, capacity);
}

/** A phone keeps Sign out in More. The rail leaves it where the published order put it. */
export function signOutOnPhone(placed: { items: NavEntry[]; more: NavEntry[] }): { items: NavEntry[]; more: NavEntry[] } {
  const signOut = [...placed.items, ...placed.more].find((item) => item.key === 'signout');
  if (!signOut || placed.more.some((item) => item.key === 'signout')) return placed;
  const items = placed.items.filter((item) => item.key !== 'signout');
  const more = [...placed.more, signOut];
  if (items.some((item) => item.menu)) return { items, more };
  const shown = items.slice(0, Math.max(PHONE_SLOTS - 1, 0));
  return { items: [...shown, MORE_ENTRY()], more: [...items.slice(shown.length), ...more] };
}

const hasKey = (list: { key: string }[], key: string | null): key is string => !!key && list.some((item) => item.key === key);

/** The nav key this address belongs to, before falling back to the Records section. */
function routeKey(path: string): string | null {
  const [top = '', second] = path.split('/');
  if (!top) return 'home';
  if (top === 'records') return second ? `record:${second}` : 'records';
  if (top === 'pages') return second ? `page:${second}` : null;
  if (top === 'inbox' || top === 'settings' || top === 'admin' || top === 'builder' || top === 'reports' || top === 'guide') return top;
  return null;
}

/**
 * Which bar item is current. A link on the bar or rail highlights itself.
 * A link that only fits in the overflow highlights More.
 */
export function activeNavItem(path: string, items: { key: string }[], overflow: { key: string }[] = []): string {
  if (isBare(path)) return '';
  const key = routeKey(path);
  if (hasKey(items, key)) return key;
  if (hasKey(overflow, key)) return items.some((item) => item.key === 'more') ? 'more' : '';
  const [top, second] = path.split('/');
  if (top === 'records' && second) {
    if (hasKey(items, 'records')) return 'records';
    if (hasKey(overflow, 'records')) return items.some((item) => item.key === 'more') ? 'more' : '';
  }
  return '';
}

export function initials(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  return letters.map((w) => [...w][0]!.toLocaleUpperCase()).join('') || '?';
}

export const plural = (type: RuntimeRecordType): string => type.pluralLabel || type.label;

export interface RecordGroupView {
  key: string;
  label: string;
  types: RuntimeRecordType[];
}

/** Record types the person can read, by record group in order; types in no group come last under "Other". */
export function recordGroups(defs: RuntimeDefinitions | null): RecordGroupView[] {
  const types = defs?.recordTypes ?? [];
  const placed = new Set<string>();
  const out: RecordGroupView[] = [];
  for (const g of defs?.recordGroups ?? []) {
    const members = g.recordTypes.map((k) => types.find((x) => x.key === k)).filter((x): x is RuntimeRecordType => !!x && !placed.has(x.key));
    members.forEach((x) => placed.add(x.key));
    if (members.length) out.push({ key: g.key, label: g.label, types: members });
  }
  const rest = types.filter((x) => !placed.has(x.key));
  if (rest.length) out.push({ key: 'other', label: t('ui.records.otherGroup'), types: rest });
  return out;
}

export function groupOf(defs: RuntimeDefinitions | null, typeKey: string): { key: string; label: string } {
  const g = recordGroups(defs).find((x) => x.types.some((y) => y.key === typeKey));
  return g ? { key: g.key, label: g.label } : { key: 'other', label: t('ui.records.otherGroup') };
}

/**
 * A same-origin or embedded organisation mark. Remote addresses are not shown.
 * Returns null when the organisation has no logo.
 */
export function organisationLogo(src: string | null | undefined): string | null {
  const value = src?.trim() ?? '';
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) return value;
  if (value.startsWith('data:image/')) return value;
  return null;
}

/** The screen's name at this address. The app bar does not use it. */
export function appTitle(route: ShellRoute, defs: RuntimeDefinitions | null, me: Me | null): string {
  const [top = '', second] = route.path.split('/');
  switch (top) {
    case '':
      return me?.tenant.name ?? '';
    case 'records': {
      const type = second ? defs?.recordTypes.find((x) => x.key === second) : undefined;
      return second ? (type ? plural(type) : second) : t('ui.nav.records');
    }
    case 'inbox':
      return t('ui.nav.inbox');
    case 'reports':
      return t('ui.nav.reports');
    case 'pages':
      return defs?.pages?.find((p) => p.key === second)?.label ?? t('ui.nav.more');
    case 'admin':
      return t('ui.crumbs.administration');
    case 'builder':
      return t('ui.builder.title');
    case 'guide':
      return t('ui.nav.guide');
    case 'settings':
      return t('ui.nav.settings');
    default:
      return t('ui.nav.more');
  }
}

type Capabilities = Me['capabilities'];

/** Administration is offered to anyone holding at least one administration permission. */
export const hasAdministration = (c: Capabilities | undefined): boolean =>
  !!c && !!(c.people || c.roles || c.connectors || c.apiKeys || c.jobs || c.audit || c.settings || c.migration);

export interface MoreLink {
  id: string;
  label: string;
  hint?: string;
  link: string;
}

export interface MoreModel {
  account: { initials: string; name: string; detail: string };
  /** Kept for the More menu. People are not a destination; the list is Administration → People. */
  directory: MoreLink | null;
  /** Administration, for anyone who may run the organisation. */
  organisation: MoreLink[];
  builder: boolean;
  twoStep: boolean;
}

export function moreModel(me: Me | null): MoreModel {
  const caps = me?.capabilities;
  const organisation: MoreLink[] = [];
  if (hasAdministration(caps)) organisation.push({ id: 'admin', label: t('ui.crumbs.administration'), hint: t('ui.more.adminHint'), link: '/admin' });
  return {
    account: {
      initials: initials(me?.displayName),
      name: me?.displayName ?? '',
      detail: [me?.email, me?.tenant.name].filter(Boolean).join(' · '),
    },
    directory: null,
    organisation,
    builder: !!caps?.configure,
    twoStep: !!me?.twoStepEnabled,
  };
}

export interface ShellGateway {
  /** Approvals waiting for the signed-in person. */
  approvalsWaiting(): Promise<number>;
}

/**
 * The Inbox badge: approvals waiting for the person. It refreshes when asked
 * (on navigation and after decisions) and every minute while the app is
 * visible; an answer older than the latest request is ignored.
 */
export class ApprovalsBadge {
  private count = 0;
  private seq = 0;
  private readonly listeners = new Set<(count: number) => void>();
  private stopTimer: (() => void) | null = null;

  constructor(
    private readonly gateway: ShellGateway,
    private readonly visible: () => boolean = () => true,
  ) {}

  get value(): number {
    return this.count;
  }

  subscribe(listener: (count: number) => void): () => void {
    this.listeners.add(listener);
    listener(this.count);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    const id = ++this.seq;
    try {
      const n = await this.gateway.approvalsWaiting();
      if (id !== this.seq) return;
      this.count = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
      this.listeners.forEach((l) => l(this.count));
    } catch {
      // Keeps the last count; the next refresh tries again.
    }
  }

  /** Refreshes now and then on `every`, which returns a function that stops it. */
  start(every: (ms: number, run: () => void) => () => void): void {
    this.stop();
    this.stopTimer = every(BADGE_REFRESH_MS, () => {
      if (this.visible()) void this.refresh();
    });
    void this.refresh();
  }

  stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }
}
