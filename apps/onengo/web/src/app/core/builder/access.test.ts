import { describe, expect, it } from 'vitest';
import { memoryGateway, sampleSeed, type SampleSeed } from '../testing/memory-gateway';
import { AccessDrafts, applyOps, elementId, permissionOps } from './access-drafts';
import { accessView, heldByNoRole, roleSummary, withChanges, type AccessAddress } from './access-map';
import { MASK, rolePreview } from './access-preview';
import type { AccessMapElement } from './http-access';
import { grantOf, permissionGrid, roleKey, togglePermission } from './permission-grid';

const ROLES = [
  { key: 'admin', label: 'Admin', permissions: ['*'] },
  { key: 'finance', label: 'Finance', permissions: ['record:donation:*', 'record:donor:read', 'record:donor:update', 'record:donor:sensitive', 'people:read'] },
  { key: 'viewer', label: 'Viewer', permissions: ['record:donation:read', 'record:donor:read', 'people:read'] },
];

function seed(): SampleSeed {
  const s = sampleSeed();
  s.roles = structuredClone(ROLES);
  s.definitions.listViews!['donation']!.chips![0]!.permission = 'donation:closed:read';
  s.definitions.listViews!['donor']!.detail!.sections[0] = { id: 'donor', label: 'Donor', fields: ['name', 'pan', 'city'] };
  return s;
}

const noTimers = { set: () => 0, clear: () => undefined };
const address = (a: Partial<AccessAddress> = {}): AccessAddress => ({ area: 'all', q: '', problems: false, ...a });
const types = [
  { key: 'donation', label: 'Donations' },
  { key: 'donor', label: 'Donors' },
];
const find = (list: AccessMapElement[], element: string, label: string, access?: string) =>
  list.find((e) => e.element === element && e.label.startsWith(label) && (!access || e.access === access))!;

describe('Role permission grid', () => {
  it('maps the catalogue to columns, steps, setup (with See people) and the strings used in definitions', async () => {
    const g = memoryGateway(seed());
    const grid = permissionGrid(await g.access.permissionCatalogue(), ['record:donation:*', 'people:read', 'donation:closed:read']);
    const donation = grid.recordTypes.find((r) => r.key === 'donation')!;
    expect(donation.cells.read).toMatchObject({ permission: 'record:donation:read', on: true, via: 'record:donation:*' });
    expect(donation.steps.map((s) => [s.label, s.permission])).toEqual([
      ['Mark as paid', 'record:donation:transition:markPaid'],
      ['Cancel donation', 'record:donation:transition:cancel'],
    ]);
    expect(grid.recordTypes.find((r) => r.key === 'donor')!.cells.read).toMatchObject({ on: false, via: null });
    expect(grid.setup.find((c) => c.permission === 'people:read')).toMatchObject({ label: 'See people', on: true, via: null });
    expect(grid.used).toEqual([{ permission: 'donation:closed:read', label: 'Used in definitions', on: true, via: null }]);
    expect(grid.extra).toEqual(['record:donation:*']);
    expect(grid.columns).toEqual(['read', 'create', 'update', 'sensitive', 'import', 'export', 'bulk']);
  });

  it('switches permissions on and off as written, keeping broader grants', () => {
    expect(togglePermission(['record:donor:read'], 'people:read', true)).toEqual(['record:donor:read', 'people:read']);
    expect(togglePermission(['record:donation:*'], 'record:donation:read', true)).toEqual(['record:donation:*']);
    expect(togglePermission(['record:donation:*', 'people:read'], 'people:read', false)).toEqual(['record:donation:*']);
    expect(togglePermission(['record:donation:*'], 'record:donation:read', false)).toEqual(['record:donation:*']);
    expect(grantOf(['*'], 'config:read')).toBe('*');
    expect(roleKey(' Programme staff ')).toBe('programme-staff');
    expect(roleKey('2nd shift')).toBe('nd-shift');
  });
});

describe('Access map view model', () => {
  it('filters by area, record type, role held and search, and groups by record type', async () => {
    const g = memoryGateway(seed());
    const roles = await g.access.roles();
    const { elements } = await g.access.accessMap();
    const chips = accessView(elements, address({ area: 'chips' }), { roles, recordTypes: types });
    expect(chips.groups.map((x) => x.id)).toEqual(['type:donation']);
    expect(chips.groups[0]!.rows.map((r) => r.label)).toEqual(['Chip Outstanding (Donations)', 'Chip Paid (Donations)', 'Chip Mine (Donations)', 'Chip All (Donations)']);
    const donor = accessView(elements, address({ recordType: 'donor' }), { roles, recordTypes: types });
    expect(donor.groups.map((x) => x.id)).toEqual(['type:donor', 'app']);
    const viewer = accessView(elements, address({ area: 'steps', heldBy: 'viewer' }), { roles, recordTypes: types });
    expect(viewer.count).toBe(0);
    const search = accessView(elements, address({ q: 'people:read' }), { roles, recordTypes: types });
    expect(search.groups.flatMap((x) => x.rows.map((r) => `${r.label}: ${r.holders}`))).toEqual(['People list (API only): Admin, Finance, Viewer']);
  });

  it('warns about permissions no role holds except through everything, and shows only problems', async () => {
    const g = memoryGateway(seed());
    const roles = await g.access.roles();
    const { elements } = await g.access.accessMap();
    const closed = find(elements, 'chip', 'Chip Outstanding');
    expect(closed.permission).toBe('donation:closed:read');
    expect(closed.roles).toEqual(['admin']);
    expect(heldByNoRole(closed, roles)).toBe(true);
    const v = accessView(elements, address({ problems: true }), { roles, recordTypes: types });
    expect(v.problems).toEqual([{ permission: 'donation:closed:read', labels: ['Chip Outstanding (Donations)'] }]);
    expect(v.count).toBe(1);
  });

  it('leaves out holders, the held-by filter and the problems view without admin:roles', async () => {
    const g = memoryGateway(seed());
    const roles = await g.access.roles();
    const { elements } = await g.access.accessMap();
    // The server sends no role holders to someone without admin:roles.
    const hidden = elements.map((e) => ({ ...e, roles: [] as string[] }));
    const without = { roles: roles.map(({ key, label }) => ({ key, label })), recordTypes: types, showRoles: false };
    const all = accessView(hidden, address(), without);
    const rows = all.groups.flatMap((x) => x.rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.holders === '' && !r.noRole)).toBe(true);
    expect(all.problems).toEqual([]);
    // A held-by or problems address left in the link does not narrow the list.
    expect(accessView(hidden, address({ heldBy: 'viewer' }), without).count).toBe(all.count);
    expect(accessView(hidden, address({ problems: true }), without).count).toBe(all.count);
    // With admin:roles the same address still narrows it.
    const withRoles = { roles, recordTypes: types };
    expect(accessView(elements, address({ problems: true }), withRoles).count).toBe(1);
    expect(accessView(elements, address(), withRoles).groups.flatMap((x) => x.rows).some((r) => r.holders !== '')).toBe(true);
  });

  it('works out holders of a pending change from the roles', async () => {
    const g = memoryGateway(seed());
    const roles = await g.access.roles();
    const { elements } = await g.access.accessMap();
    const chip = find(elements, 'chip', 'Chip Outstanding');
    const changed = withChanges(elements, [{ id: elementId(chip), element: chip, value: 'record:donation:read', permission: 'record:donation:read' }], roles, 'viewer');
    const after = find(changed, 'chip', 'Chip Outstanding');
    expect(after).toMatchObject({ permission: 'record:donation:read', roles: ['admin', 'finance', 'viewer'], visible: true, warnings: [] });
    expect(heldByNoRole(after, roles)).toBe(false);
  });

  it('summarises and previews what a role sees', async () => {
    const s = seed();
    const g = memoryGateway(s);
    const map = await g.access.accessMap({ role: 'viewer' });
    expect(map.role).toMatchObject({ key: 'viewer', label: 'Viewer' });
    const summary = roleSummary(map.elements, types);
    expect(summary.records.map((r) => [r.label, r.visible, ...r.lines])).toEqual([
      ['Donations', true, 'Can: see', 'Read-only: Donor, Donor name, Amount, Method, Paid on, Purpose, Anonymous, Notes', 'Hidden chips: Outstanding', 'Not available: Mark as paid, Cancel donation'],
      ['Donors', true, 'Can: see', 'Masked: PAN', 'Read-only: Name, Phone, Email, PAN, City'],
    ]);
    expect(summary.areas.find((a) => a.label === 'People list (API only)')).toEqual({ label: 'People list (API only)', on: true });
    expect(summary.areas.find((a) => a.label === 'Builder')).toEqual({ label: 'Builder', on: false });

    const donorType = s.definitions.recordTypes.find((x) => x.key === 'donor')!;
    const preview = rolePreview({ type: donorType, view: s.definitions.listViews!['donor'], elements: map.elements });
    expect(preview).toMatchObject({ visible: true, canCreate: false, steps: [] });
    const fields = preview.sections.find((x) => x.id === 'donor');
    expect(fields).toMatchObject({ kind: 'fields', fields: [{ label: 'Name', value: 'Name 1' }, { label: 'PAN', value: MASK }, { label: 'City', value: 'City 1' }] });

    const donationType = s.definitions.recordTypes.find((x) => x.key === 'donation')!;
    const list = rolePreview({ type: donationType, workflow: s.definitions.workflows['donation'], view: s.definitions.listViews!['donation'], elements: map.elements });
    expect(list.chips.map((c) => c.id)).toEqual(['paid', 'mine', 'all']);
    expect(list.rows).toHaveLength(3);
  });
});

describe('Inline permission changes', () => {
  it('turn into draft operations on the owning definition', async () => {
    const g = memoryGateway(seed());
    const { elements } = await g.access.accessMap();
    const donor = (await g.builder.detail('recordType', 'donor')).published!.body;
    const pan = find(elements, 'field', 'PAN', 'see');
    expect(pan.definition).toEqual({ kind: 'recordType', key: 'donor', path: '/fields/3/readPermission' });
    expect(permissionOps(pan, 'donor:pan:read', donor)).toEqual([
      { op: 'remove', path: '/fields/3/sensitive' },
      { op: 'set', path: '/fields/3/readPermission', value: 'donor:pan:read' },
    ]);
    expect(permissionOps(pan, 'record:donor:sensitive', donor)).toEqual([{ op: 'remove', path: '/fields/3/readPermission' }]);
    const changed = applyOps(donor, permissionOps(pan, 'donor:pan:read', donor)!);
    expect((changed['fields'] as Record<string, unknown>[])[3]).toEqual({ key: 'pan', label: 'PAN', type: 'text', readPermission: 'donor:pan:read' });

    const step = find(elements, 'step', 'Step Mark as paid');
    const workflow = (await g.builder.detail('workflow', 'donation')).published!.body;
    expect(permissionOps(step, ' donation:pay ', workflow)).toEqual([{ op: 'set', path: '/transitions/0/permission', value: 'donation:pay' }]);
    expect(permissionOps(step, 'record:donation:transition:markPaid', workflow)).toEqual([{ op: 'remove', path: '/transitions/0/permission' }]);
    expect(permissionOps(find(elements, 'recordType', 'See Donations'), 'x', donor)).toBeNull();
  });

  it('saves drafts of each definition and publishes them together', async () => {
    const s = seed();
    const g = memoryGateway(s);
    await g.builder.saveDraft('listView', 'donations', s.definitions.listViews!['donation']);
    await g.builder.publish('listView', 'donations');
    const { elements } = await g.access.accessMap();
    const drafts = new AccessDrafts(g.builder, { timers: noTimers });
    expect(await drafts.change(find(elements, 'step', 'Step Mark as paid'), 'donation:pay')).toBe(true);
    expect(await drafts.change(find(elements, 'chip', 'Chip Outstanding'), '')).toBe(true);
    expect(drafts.snapshot.pending.map((p) => [p.element.definition!.kind, p.permission])).toEqual([
      ['workflow', 'donation:pay'],
      ['listView', 'record:donation:read'],
    ]);
    expect(drafts.snapshot.drafts.map((d) => `${d.kind}/${d.key}`)).toEqual(['workflow/donation', 'listView/donations']);

    g.calls.length = 0;
    expect(await drafts.publishAll()).toBe(true);
    expect(g.calls.filter((c) => ['savePatch', 'saveDraft', 'publish'].includes(c.op)).map((c) => `${c.op} ${c.args[0]}/${c.args[1]}`)).toEqual([
      'savePatch workflow/donation',
      'saveDraft listView/donations',
      'publish listView/donations',
    ]);
    const wf = (await g.builder.detail('workflow', 'donation')).published!.body as { transitions: { permission?: string }[] };
    expect(wf.transitions[0]!.permission).toBe('donation:pay');
    const view = (await g.builder.detail('listView', 'donations')).published!.body as { chips: { permission?: string }[] };
    expect(view.chips[0]!.permission).toBeUndefined();
    expect(drafts.snapshot).toMatchObject({ pending: [], drafts: [], message: 'Published. The new permissions apply now.' });
    await drafts.dispose();
  });
});
