import { afterEach, describe, expect, it } from 'vitest';
import { trail, type Crumb, type CrumbLabels } from './breadcrumbs';
import { addText, ENGLISH, flattenMessages, t, useMessages } from '../i18n/i18n';
import type { RuntimeDefinitions } from '../models';
import { shellRoute } from './shell';
import { sampleSeed } from '../testing/sample-data';

function defs(): RuntimeDefinitions {
  const d = sampleSeed().definitions;
  d.listViews!['donation']!.create = { ...d.listViews!['donation']!.create, presets: [{ param: 'donor', field: 'donor' }] };
  d.actions = {
    donation: [{ key: 'sendReminder', recordType: 'donation', label: 'Send reminder', placement: ['panel'], steps: [], allowed: true }],
  };
  d.pages = [
    { key: 'home', label: 'Home', widgets: [] },
    { key: 'fundraising', label: 'Fundraising dashboard', widgets: [] },
  ];
  return d;
}

const at = (url: string, labels?: CrumbLabels, d: RuntimeDefinitions | null = defs()): Crumb[] => {
  const { path, params } = shellRoute(url);
  return trail(path, params, d, labels);
};
const labels = (url: string, l?: CrumbLabels) => at(url, l).map((c) => c.label);

afterEach(() => {
  useMessages('en', ENGLISH);
});

describe('breadcrumb trail', () => {
  it('starts at the destination, with no leading Home', () => {
    expect(at('/')).toEqual([{ label: 'Home' }]);
    expect(at('/records')).toEqual([{ label: 'Records' }]);
    expect(labels('/inbox')[0]).toBe('Inbox');
  });

  it('is empty on sign-in, reset password and the print view', () => {
    expect(at('/sign-in?next=/records')).toEqual([]);
    expect(at('/reset-password?token=x')).toEqual([]);
    expect(at('/print/receipt/r1')).toEqual([]);
  });

  it('gives a list its group and plural label, every item but the last a link', () => {
    expect(at('/records/donation')).toEqual([
      { label: 'Records', href: '/records' },
      { label: 'Fundraising', href: '/records#group-fundraising' },
      { label: 'Donations' },
    ]);
  });

  it('puts a list without a group under Other', () => {
    const d = defs();
    d.recordGroups = [];
    expect(at('/records/donor', {}, d).map((c) => c.label)).toEqual(['Records', 'Other', 'Donors']);
    expect(at('/records/donor', {}, d)[1]!.href).toBe('/records#group-other');
  });

  it('adds the open record by number and title once loaded, keeping the list’s own parameters on the way back', () => {
    const t = at('/records/donation?chip=mine&q=ravi&sort=-amount&filters=open&id=40', { named: { record: 'DON/2026-27/00040 · Ravi Kumar' } });
    expect(t.map((c) => c.label)).toEqual(['Records', 'Fundraising', 'Donations', 'DON/2026-27/00040 · Ravi Kumar']);
    expect(t[2]!.href).toBe('/records/donation?chip=mine&q=ravi&sort=-amount');
    expect(t[3]!.href).toBeUndefined();
    expect(labels('/records/donation?id=40')).toEqual(['Records', 'Fundraising', 'Donations', 'Record']);
  });

  it('names the create form and leaves its presets out of the list link', () => {
    const t = at('/records/donation?chip=mine&create=new&createStep=1&donor=d7');
    expect(t.map((c) => c.label)).toEqual(['Records', 'Fundraising', 'Donations', 'New donation']);
    expect(t[2]!.href).toBe('/records/donation?chip=mine');
  });

  it('adds each panel mode, the record linking back to its view', () => {
    const named = { record: 'DON/2026-27/00040 · Ravi Kumar' };
    const edit = at('/records/donation?chip=mine&id=40&panel=edit', { named });
    expect(edit.map((c) => c.label).slice(3)).toEqual(['DON/2026-27/00040 · Ravi Kumar', 'Edit']);
    expect(edit[3]!.href).toBe('/records/donation?chip=mine&id=40');
    expect(labels('/records/donation?id=40&panel=step:markPaid', { named }).at(-1)).toBe('Mark as paid');
    expect(labels('/records/donation?id=40&panel=action:sendReminder', { named }).at(-1)).toBe('Send reminder');
    expect(labels('/records/donation?id=40&panel=share', { named }).at(-1)).toBe('Share');
    expect(labels('/records/donation?id=40&panel=file:f81', { named: { ...named, file: 'house-photo.jpg' } }).at(-1)).toBe('house-photo.jpg');
    expect(labels('/records/donation?id=40&panel=step:unknown', { named }).at(-1)).toBe('DON/2026-27/00040 · Ravi Kumar');
    expect(labels('/records/donor?import=new')).toEqual(['Records', 'Fundraising', 'Donors', 'Import']);
  });

  it('reads the record and create redirects the same way', () => {
    expect(labels('/records/donation/new')).toEqual(['Records', 'Fundraising', 'Donations', 'New donation']);
    expect(labels('/records/donation/40', { named: { record: 'DON/40' } })).toEqual(['Records', 'Fundraising', 'Donations', 'DON/40']);
  });

  it('names the Inbox tab, or the tab the screen reports', () => {
    expect(at('/inbox?tab=approvals')).toEqual([{ label: 'Inbox', href: '/inbox' }, { label: 'Approvals' }]);
    expect(labels('/inbox?tab=notifications')).toEqual(['Inbox', 'Notifications']);
    expect(labels('/inbox', { last: 'Notifications' })).toEqual(['Inbox', 'Notifications']);
  });

  it('follows Reports like Records: group, report, then the parameter panel', () => {
    expect(at('/reports')).toEqual([{ label: 'Reports' }]);
    const named = { report: 'Donation summary', reportGroup: 'Fundraising' };
    expect(at('/reports/donationSummary', { named })).toEqual([
      { label: 'Reports', href: '/reports' },
      { label: 'Fundraising', href: '/reports' },
      { label: 'Donation summary' },
    ]);
    const create = at('/reports/donationSummary?create=new&from=2026-04-01', { named });
    expect(create.map((c) => c.label)).toEqual(['Reports', 'Fundraising', 'Donation summary', 'New donation summary']);
    expect(create[2]!.href).toBe('/reports/donationSummary');
    expect(labels('/reports/donationSummary')).toEqual(['Reports', 'donationSummary']);
    expect(at('/print/report/donationSummary')).toEqual([]);
  });

  it('names a page and Settings on their own', () => {
    expect(at('/pages/fundraising')).toEqual([{ label: 'Fundraising dashboard' }]);
    expect(at('/pages/home')).toEqual([{ label: 'Home' }]);
    expect(at('/more')).toEqual([]);
    expect(at('/settings')).toEqual([{ label: 'Settings' }]);
    expect(labels('/settings?panel=about')).toEqual(['Settings', 'About this app']);
    expect(at('/settings?panel=language')[0]?.href).toBe('/settings');
    expect(at('/guide')).toEqual([{ label: 'User guide' }]);
  });

  it('covers every Administration area and its items', () => {
    expect(at('/admin')).toEqual([{ label: 'Administration' }]);
    const direct = { theme: 'Theme', layout: 'Layout' };
    for (const [area, label] of Object.entries(direct)) {
      expect(at(`/admin/${area}`), area).toEqual([{ label: 'Administration', href: '/admin' }, { label }]);
    }
    expect(at('/admin/people')).toEqual([
      { label: 'Administration', href: '/admin' },
      { label: 'People and roles', href: '/admin#admin-people' },
      { label: 'People' },
    ]);
    expect(at('/admin/roles')).toEqual([
      { label: 'Administration', href: '/admin' },
      { label: 'People and roles', href: '/admin#admin-people' },
      { label: 'Roles' },
    ]);
    expect(at('/admin/connectors')).toEqual([
      { label: 'Administration', href: '/admin' },
      { label: 'Integrations', href: '/admin#admin-integrations' },
      { label: 'Connectors' },
    ]);
    expect(at('/admin/api-keys')).toEqual([
      { label: 'Administration', href: '/admin' },
      { label: 'Integrations', href: '/admin#admin-integrations' },
      { label: 'API keys' },
    ]);
    expect(at('/admin/jobs')).toEqual([
      { label: 'Administration', href: '/admin' },
      { label: 'Activity', href: '/admin#admin-activity' },
      { label: 'Background jobs' },
    ]);
    expect(at('/admin/audit')).toEqual([
      { label: 'Administration', href: '/admin' },
      { label: 'Activity', href: '/admin#admin-activity' },
      { label: 'Audit log' },
    ]);
    const person = at('/admin/people?status=invited&person=u7', { named: { person: 'Ravi Kumar' } });
    expect(person.map((c) => c.label)).toEqual(['Administration', 'People and roles', 'People', 'Ravi Kumar']);
    expect(person[2]!.href).toBe('/admin/people?status=invited');
    expect(labels('/admin/people?add')).toEqual(['Administration', 'People and roles', 'People', 'Add a person']);
    expect(labels('/admin/roles/finance', { named: { role: 'Finance' } })).toEqual(['Administration', 'People and roles', 'Roles', 'Finance']);
    const add = at('/admin/roles/finance?add', { named: { role: 'Finance' } });
    expect(add.map((c) => c.label)).toEqual(['Administration', 'People and roles', 'Roles', 'Finance', 'Add people']);
    expect(add[3]!.href).toBe('/admin/roles/finance');
    expect(labels('/admin/connectors/whatsapp', { named: { connector: 'WhatsApp Business' } }).at(-1)).toBe('WhatsApp Business');
    expect(labels('/admin/connectors?create').at(-1)).toBe('New connector');
    expect(labels('/admin/api-keys?create').at(-1)).toBe('New API key');
    expect(labels('/admin/jobs?job=j1', { named: { job: 'Mark as paid · 214 donations' } }).at(-1)).toBe('Mark as paid · 214 donations');
    expect(at('/admin/organisation/profile')).toEqual([
      { label: 'Administration', href: '/admin' },
      { label: 'Organisation', href: '/admin#admin-organisation' },
      { label: 'Profile' },
    ]);
    expect(labels('/admin/organisation/registrations')).toEqual(['Administration', 'Organisation', 'Registrations']);
    expect(labels('/admin/organisation/identity')).toEqual(['Administration', 'Organisation', 'Identity']);
    expect(labels('/admin/organisation/settings')).toEqual(['Administration', 'Organisation', 'Settings']);
  });

  it('follows the Builder: group, kind, definition, then the tab or selection', () => {
    expect(at('/builder')).toEqual([{ label: 'Builder' }]);
    expect(at('/builder?kind=recordType')).toEqual([
      { label: 'Builder', href: '/builder' },
      { label: 'Data', href: '/builder#builder-data' },
      { label: 'Record types' },
    ]);
    expect(labels('/builder?kind=nonsense')).toEqual(['Builder']);
    expect(at('/builder/recordType/donation?field=donorName', { named: { definition: 'Donation' }, last: 'Field: Donor name' })).toEqual([
      { label: 'Builder', href: '/builder' },
      { label: 'Data', href: '/builder#builder-data' },
      { label: 'Record types', href: '/builder?kind=recordType' },
      { label: 'Donation', href: '/builder/recordType/donation' },
      { label: 'Field: Donor name' },
    ]);
    expect(labels('/builder/workflow/donation', { named: { definition: 'Donation workflow' } })).toEqual(['Builder', 'Process', 'Workflows', 'Donation workflow']);
    expect(labels('/builder/listView/donations?tab=changes', { last: 'Changes' })).toEqual(['Builder', 'Data', 'Lists', 'donations', 'Changes']);
    expect(labels('/builder/roles/finance', { named: { definition: 'Finance' } })).toEqual(['Builder', 'Roles', 'Finance']);
    expect(labels('/builder/modules')).toEqual(['Builder', 'Advanced', 'Modules']);
    expect(labels('/builder/access?role=viewer', { named: { role: 'Viewer' } })).toEqual(['Builder', 'Access', 'Viewer']);
    expect(labels('/builder/translations?locale=hi', { named: { locale: 'हिन्दी' } })).toEqual(['Builder', 'Look and navigation', 'Translations', 'हिन्दी']);
    expect(labels('/builder/theme')).toEqual(['Builder', 'Look and navigation', 'Theme']);
    expect(labels('/builder/layout')).toEqual(['Builder', 'Look and navigation', 'Layout']);
  });

  it('translates its labels; record and definition labels come from the data', () => {
    useMessages('hi', { 'ui.nav.records': 'रिकॉर्ड', 'ui.more.about': 'इस ऐप के बारे में', 'ui.common.edit': 'बदलें' });
    expect(labels('/records/donation?id=40&panel=edit', { named: { record: 'DON/40' } })).toEqual(['रिकॉर्ड', 'Fundraising', 'Donations', 'DON/40', 'बदलें']);
    expect(labels('/settings?panel=about')).toEqual(['Settings', 'इस ऐप के बारे में']);
  });

  it('names Settings from the shipped Hindi catalogue when the server still has the English word', async () => {
    const hindi = flattenMessages((await import('@onengo/product/locale/hi.json')).default);
    useMessages('hi', { ...ENGLISH });
    addText('hi', hindi);
    expect(t('ui.nav.settings')).toBe('सेटिंग्स');
    expect(labels('/settings')).toEqual(['सेटिंग्स']);
    expect(labels('/settings?panel=about')).toEqual(['सेटिंग्स', hindi['ui.more.about']]);
  });

  it('draws nothing for an unknown route and works before the definitions load', () => {
    expect(at('/nowhere')).toEqual([]);
    expect(at('/records/donation', {}, null).map((c) => c.label)).toEqual(['Records', 'Other', 'donation']);
  });
});
