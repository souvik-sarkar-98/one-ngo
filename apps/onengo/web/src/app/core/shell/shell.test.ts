import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeNext } from '@onengo/web-kit';
import { changesApprovals } from '../http/http-shell';
import { ENGLISH, useMessages } from '../i18n/i18n';
import { LANGUAGES, languageName } from '../i18n/languages';
import type { Me, RuntimeDefinitions } from '../models';
import {
  ApprovalsBadge,
  BADGE_REFRESH_MS,
  PHONE_SLOTS,
  activeDestination,
  activeNavItem,
  canRunReports,
  navFor,
  navigationLayout,
  railCapacity,
  signOutOnPhone,
  appTitle,
  organisationLogo,
  hasAdministration,
  initials,
  isBare,
  isTopLevel,
  moreModel,
  defaultNavIcon,
  navEntries,
  recordGroups,
  shellRoute,
} from './shell';
import { sampleSeed } from '../testing/sample-data';

const defs = (): RuntimeDefinitions => sampleSeed().definitions;

function me(capabilities: Partial<Me['capabilities']> = {}): Me {
  return {
    userId: 'u1',
    displayName: 'Asha Sharma',
    email: 'asha@demo.local',
    twoStepEnabled: true,
    tenant: { id: 't1', key: 'demo', name: 'Demo Foundation' },
    roles: ['viewer'],
    permissions: [],
    capabilities: { configure: false, publish: false, scripts: false, money: false, ...capabilities },
  };
}

afterEach(() => {
  useMessages('en', ENGLISH);
});

describe('shell navigation', () => {
  it('has the destinations in order', () => {
    expect(navEntries(0).map((d) => [d.key, d.label, d.link, d.badge])).toEqual([
      ['home', 'Home', '/', undefined],
      ['records', 'Records', '/records', undefined],
      ['inbox', 'Inbox', '/inbox', undefined],
      ['reports', 'Reports', '/reports', undefined],
      ['guide', 'User guide', '/guide', undefined],
      ['settings', 'Settings', '/settings', undefined],
      ['signout', 'Sign out', '', undefined],
    ]);
    expect(navEntries(4).filter((d) => d.badge).map((d) => [d.key, d.badge])).toEqual([['inbox', 4]]);
  });

  it('labels the destinations in the person’s language', () => {
    useMessages('hi', { 'ui.nav.home': 'होम', 'ui.nav.more': 'और' });
    expect(navEntries(0).map((d) => d.label)).toEqual(['होम', 'Records', 'Inbox', 'Reports', 'User guide', 'Settings', 'Sign out']);
    expect(navFor(navigationLayout(me(), null, 0), PHONE_SLOTS + 3).items.at(-1)?.label).toBe('Sign out');
    expect(navFor(navigationLayout(me(), null, 0), PHONE_SLOTS).items.at(-1)?.label).toBe('और');
  });

  it('derives the active destination from the route', () => {
    expect(['', 'records', 'records/donation', 'inbox', 'more', 'pages/fundraising', 'admin/roles/finance', 'builder/recordType/donation'].map(activeDestination)).toEqual([
      'home',
      'records',
      'records',
      'inbox',
      null,
      null,
      null,
      null,
    ]);
    expect(activeDestination('sign-in')).toBeNull();
    expect(activeDestination('guide')).toBeNull();
    expect(activeDestination('print/receipt/r1')).toBeNull();
  });

  it('shows every link that fits, and More only for the overflow, in the published order', () => {
    const d = defs();
    d.pages = [{ key: 'fundraising', label: 'Fundraising dashboard', widgets: [] }];
    d.navigation = {
      items: ['home', 'record:donor', 'record:donation', 'inbox', 'records', 'record:missing', 'page:fundraising', 'settings', 'admin'],
    };
    const layout = navigationLayout(me({ configure: true }), d, 2);
    expect(layout.items.map((item) => [item.key, item.link])).toEqual([
      ['home', '/'],
      ['record:donor', '/records/donor'],
      ['record:donation', '/records/donation'],
      ['inbox', '/inbox'],
      ['records', '/records'],
      ['page:fundraising', '/pages/fundraising'],
      ['guide', '/guide'],
      ['settings', '/settings'],
      ['signout', ''],
    ]);
    expect(layout.items.find((item) => item.key === 'inbox')?.badge).toBe(2);
    const phone = navFor(layout, PHONE_SLOTS);
    expect(phone.items.map((item) => item.key)).toEqual(['home', 'record:donor', 'record:donation', 'more']);
    expect(phone.more.map((item) => item.key)).toEqual(['inbox', 'records', 'page:fundraising', 'guide', 'settings', 'signout']);
    expect(phone.items.find((item) => item.key === 'more')?.link).toBe('');
    const tall = navFor(layout, railCapacity(900));
    expect(tall.items.map((item) => item.key)).toEqual(['home', 'record:donor', 'record:donation', 'inbox', 'records', 'page:fundraising', 'guide', 'settings', 'signout']);
    expect(tall.more).toEqual([]);
    expect(railCapacity(340)).toBe(4);
    expect(navFor(layout, railCapacity(340)).items.map((item) => item.key)).toEqual(['home', 'record:donor', 'record:donation', 'more']);
    expect(navFor(navigationLayout(me(), null, 0), PHONE_SLOTS + 3).items.some((item) => item.key === 'more')).toBe(false);
    expect(signOutOnPhone({ items: [{ key: 'home', label: 'Home', icon: 'home', link: '/' }, { key: 'signout', label: 'Sign out', icon: 'logout', link: '', command: 'sign-out' }], more: [] }).more.map((item) => item.key)).toEqual(['signout']);
    expect(navFor(navigationLayout(me({ peopleDirectory: true }), null, 0), PHONE_SLOTS).more.some((item) => item.key === 'people')).toBe(false);
    expect(activeNavItem('records/donation', phone.items, phone.more)).toBe('record:donation');
    expect(activeNavItem('records', phone.items, phone.more)).toBe('more');
    expect(activeNavItem('settings', phone.items, phone.more)).toBe('more');
    expect(activeNavItem('admin/people', tall.items, tall.more)).toBe('');
    const withAdmin = navFor(navigationLayout(me({ people: true }), d, 0), PHONE_SLOTS);
    expect(activeNavItem('admin/people', withAdmin.items, withAdmin.more)).toBe('more');
    const wideAdmin = navFor(navigationLayout(me({ people: true }), d, 0), railCapacity(900));
    expect(activeNavItem('admin/people', wideAdmin.items, wideAdmin.more)).toBe('admin');
  });

  it('uses a published icon, and the destination’s own icon otherwise', () => {
    const d = defs();
    d.navigation = { items: ['home', 'inbox', 'admin'], icons: { inbox: 'bell' } };
    const layout = navigationLayout(me({ people: true }), d, 0);
    expect(layout.items.find((item) => item.key === 'inbox')?.icon).toBe('bell');
    expect(layout.items.find((item) => item.key === 'home')?.icon).toBe('home');
    expect(layout.items.find((item) => item.key === 'admin')?.icon).toBe('admin_panel_settings');
    expect(defaultNavIcon('builder')).toBe('build');
    expect(layout.items.find((item) => item.key === 'guide')?.icon).toBe('menu_book');
  });

  it('shows the back arrow away from the destinations and no chrome on sign-in, reset password and print', () => {
    expect(['', 'records', 'inbox'].every(isTopLevel)).toBe(true);
    expect(['records/donation', 'pages/x', 'builder', 'admin', 'more'].some(isTopLevel)).toBe(false);
    expect(['sign-in', 'o/demo/sign-in', 'reset-password', 'print/receipt/r1', 'r/token'].every(isBare)).toBe(true);
    expect(isBare('records')).toBe(false);
  });

  it('reads a route from the address', () => {
    expect(shellRoute('/records/donation?chip=mine&q=ravi%20k#top')).toEqual({ path: 'records/donation', params: { chip: 'mine', q: 'ravi k' } });
    expect(shellRoute('/')).toEqual({ path: '', params: {} });
  });

  it('names the screen: the organisation on Home and the screen name elsewhere', () => {
    const d = defs();
    expect(appTitle(shellRoute('/'), d, me())).toBe('Demo Foundation');
    expect(appTitle(shellRoute('/records'), d, me())).toBe('Records');
    expect(appTitle(shellRoute('/records/donation?id=1'), d, me())).toBe('Donations');
    expect(appTitle(shellRoute('/more?panel=about'), d, me())).toBe('More');
    expect(appTitle(shellRoute('/admin/people'), d, me())).toBe('Administration');
    expect(appTitle(shellRoute('/builder/recordType/donation'), d, me())).toBe('Builder');
    expect(appTitle(shellRoute('/guide'), d, me())).toBe('User guide');
  });

  it('shows an organisation logo only from inside the app', () => {
    expect(organisationLogo('/files/mark.png')).toBe('/files/mark.png');
    expect(organisationLogo(' data:image/png;base64,aaa ')).toBe('data:image/png;base64,aaa');
    expect(organisationLogo(null)).toBeNull();
    expect(organisationLogo('')).toBeNull();
    expect(organisationLogo('https://cdn.example/logo.png')).toBeNull();
    expect(organisationLogo('//cdn.example/logo.png')).toBeNull();
  });

  it('makes initials from the first and last name', () => {
    expect(initials('Asha Sharma')).toBe('AS');
    expect(initials('meena  k  iyer')).toBe('MI');
    expect(initials('Ravi')).toBe('R');
    expect(initials('')).toBe('?');
  });

  it('goes after sign-in only to an address inside the app', () => {
    expect(safeNext('/records/donation?id=4')).toBe('/records/donation?id=4');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
    for (const bad of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/%09/evil.example', '/%2F/evil.example', '/%5Cevil.example', '/.//evil.example', 'javascript:alert(1)']) {
      expect(safeNext(bad), JSON.stringify(bad)).toBe('/');
    }
    expect(safeNext('/records/../inbox?tab=mine#top')).toBe('/inbox?tab=mine#top');
  });

  it('groups record types by record group, the rest under Other', () => {
    const d = defs();
    d.recordGroups = [{ key: 'giving', label: 'Giving', recordTypes: ['donation', 'missing'] }];
    expect(recordGroups(d).map((g) => [g.key, g.label, g.types.map((x) => x.key)])).toEqual([
      ['giving', 'Giving', ['donation']],
      ['other', 'Other', ['donor']],
    ]);
  });
});

describe('Reports destinations', () => {
  const withPermissions = (permissions: string[], capabilities: Partial<Me['capabilities']> = {}): Me => ({ ...me(capabilities), permissions });
  const keys = (person: Me) => navigationLayout(person, null, 0).items.map((item) => item.key);

  it('leaves People out of the bar, including for the directory permission and a published people item', () => {
    expect(keys(me())).not.toContain('people');
    expect(keys(me({ people: true }))).not.toContain('people');
    expect(keys(me({ peopleDirectory: true, audit: true }))).toEqual(['home', 'records', 'inbox', 'admin', 'guide', 'settings', 'signout']);
    const d = defs();
    d.navigation = { items: ['home', 'people'] };
    expect(navigationLayout(me({ peopleDirectory: true }), d, 0).items.map((item) => item.key)).toEqual(['home', 'guide', 'signout']);
    expect(isTopLevel('people')).toBe(false);
    expect(activeNavItem('people', navigationLayout(me({ peopleDirectory: true }), null, 0).items)).toBe('');
  });

  it('shows Reports only when a grant could run a report', () => {
    expect(keys(withPermissions([]))).not.toContain('reports');
    expect(keys(withPermissions(['record:donation:read', 'inbox:read']))).not.toContain('reports');
    expect(keys(withPermissions(['report:*:run']))).toContain('reports');
    expect(keys(withPermissions(['report:donations:run']))).toContain('reports');
    expect(keys(withPermissions(['report:*']))).toContain('reports');
    expect(keys(withPermissions(['*']))).toContain('reports');
    expect(navigationLayout(withPermissions(['report:donations:run']), null, 0).items.find((item) => item.key === 'reports')).toMatchObject({ link: '/reports' });
  });

  it('hides Reports from a published order when no report can be run', () => {
    const d = defs();
    d.navigation = { items: ['home', 'reports'] };
    expect(navigationLayout(withPermissions([]), d, 0).items.map((item) => item.key)).toEqual(['home', 'guide', 'signout']);
    expect(navigationLayout(withPermissions(['report:x:run']), d, 0).items.map((item) => item.key)).toEqual(['home', 'reports', 'guide', 'signout']);
  });

  it('reads a grant that cannot run reports as no reports', () => {
    expect(canRunReports(undefined)).toBe(false);
    expect(canRunReports(['record:report:read', 'admin:*', 'reports:x:run'])).toBe(false);
    expect(canRunReports(['record:x:read', 'report:x:run'])).toBe(true);
  });
});

describe('More', () => {
  it('shows the account on the card: initials, name, email and organisation', () => {
    expect(moreModel(me()).account).toEqual({ initials: 'AS', name: 'Asha Sharma', detail: 'asha@demo.local · Demo Foundation' });
  });

  it('offers Administration under More, and no people directory', () => {
    const entries = (c: Partial<Me['capabilities']>) => moreModel(me(c)).organisation.map((o) => [o.label, o.link]);
    expect(entries({})).toEqual([]);
    expect(moreModel(me({ peopleDirectory: true })).directory).toBeNull();
    expect(entries({ peopleDirectory: true })).toEqual([]);
    for (const area of ['people', 'roles', 'connectors', 'apiKeys', 'jobs', 'audit', 'settings'] as const) {
      expect(entries({ [area]: true }), area).toEqual([['Administration', '/admin']]);
    }
    expect(entries({ peopleDirectory: true, audit: true })).toEqual([['Administration', '/admin']]);
    expect(hasAdministration(me({ configure: true, publish: true }).capabilities)).toBe(false);
  });

  it('offers Builder for configurers and shows the two-step state', () => {
    const m = moreModel(me({ configure: true }));
    expect(m.builder).toBe(true);
    expect(m.twoStep).toBe(true);
    expect(moreModel(me()).builder).toBe(false);
  });

  it('lists the six languages in their own scripts', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'hi', 'ta', 'te', 'bn', 'mr']);
    expect(languageName('en')).toBe('English');
    expect(languageName('hi')).toBe('हिन्दी');
  });
});

describe('approvals badge', () => {
  it('counts approvals waiting, refreshes every minute while visible, and ignores older answers', async () => {
    vi.useFakeTimers();
    try {
      let waiting = 4;
      let visible = true;
      const gateway = { approvalsWaiting: vi.fn(async () => waiting) };
      const badge = new ApprovalsBadge(gateway, () => visible);
      const seen: number[] = [];
      badge.subscribe((n) => seen.push(n));
      badge.start((ms, run) => {
        const id = setInterval(run, ms);
        return () => clearInterval(id);
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(badge.value).toBe(4);
      waiting = 3;
      await vi.advanceTimersByTimeAsync(BADGE_REFRESH_MS);
      expect(badge.value).toBe(3);
      visible = false;
      waiting = 9;
      await vi.advanceTimersByTimeAsync(BADGE_REFRESH_MS);
      expect(badge.value).toBe(3);
      badge.stop();
      expect(gateway.approvalsWaiting).toHaveBeenCalledTimes(2);
      expect(seen).toEqual([0, 4, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the latest answer and the last count when a refresh fails', async () => {
    const answers: ((n: number) => void)[] = [];
    let fail = false;
    const badge = new ApprovalsBadge({ approvalsWaiting: () => (fail ? Promise.reject(new Error('offline')) : new Promise<number>((r) => answers.push(r))) });
    const first = badge.refresh();
    const second = badge.refresh();
    answers[1]!(2);
    answers[0]!(7);
    await Promise.all([first, second]);
    expect(badge.value).toBe(2);
    fail = true;
    await badge.refresh();
    expect(badge.value).toBe(2);
  });

  it('refreshes after decisions, withdrawals and workflow steps, not after reads', () => {
    expect(changesApprovals('POST', '/api/approvals/a1/decision')).toBe(true);
    expect(changesApprovals('POST', '/api/approvals/a1/withdraw')).toBe(true);
    expect(changesApprovals('POST', '/api/records/donation/d1/transitions/markPaid')).toBe(true);
    expect(changesApprovals('POST', '/api/approvals/query')).toBe(false);
    expect(changesApprovals('GET', '/api/approvals/count')).toBe(false);
    expect(changesApprovals('PATCH', '/api/records/donation/d1')).toBe(false);
  });
});
