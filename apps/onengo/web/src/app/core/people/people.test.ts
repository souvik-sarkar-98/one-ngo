import { describe, expect, it } from 'vitest';
import { parsePeopleAddress, patchPeople, peopleKey, peopleParams, peoplePushes, type PeopleAddress } from './address';
import { peopleQuery } from './people-session';
import { directorySections, peopleColumns, personRow, statusChips } from './rows';
import { peopleHarness } from './testing';

const reader = (p: Record<string, string>) => (n: string) => p[n] ?? null;

describe('People address contract', () => {
  it('reads the directory address and the name sort, and ignores status', () => {
    const a = parsePeopleAddress(reader({ role: 'finance,viewer', q: ' ravi ', sort: '-name', person: 'u-ravi', status: 'invited', add: '' }), 'directory');
    expect(a).toEqual({ status: 'active', q: 'ravi', role: ['finance', 'viewer'], sort: { field: 'name', dir: 'desc' }, show: 30, person: 'u-ravi', add: false });
    expect(parsePeopleAddress(reader({ sort: 'joined' }), 'directory').sort).toBeUndefined();
  });

  it('reads management: status chip (Active by default), add, and the joined and status sorts; drops invalid values', () => {
    expect(parsePeopleAddress(reader({ status: 'suspended', sort: 'joined', add: '' }), 'management')).toMatchObject({ status: 'suspended', sort: { field: 'joined', dir: 'asc' }, add: true });
    expect(parsePeopleAddress(reader({ status: 'gone', show: 'x' }), 'management')).toMatchObject({ status: 'active', show: 30 });
  });

  it('writes every parameter it owns and leaves the default chip out', () => {
    const a = parsePeopleAddress(reader({ status: 'invited', q: 'f', add: '' }), 'management');
    expect(peopleParams(a, 'management')).toEqual({ status: 'invited', add: '', q: 'f', role: null, sort: null, show: null, person: null });
    expect(peopleParams({ ...a, status: 'active', add: false }, 'management')).toMatchObject({ status: null, add: null });
    const d = parsePeopleAddress(reader({ role: 'finance' }), 'directory');
    expect(peopleParams(d, 'directory')).toEqual({ q: null, role: 'finance', sort: null, show: null, person: null });
    expect(peopleParams(d, 'directory')).not.toHaveProperty('status');
  });

  it('pushes only when a person or Add opens, and a new search starts from the first page', () => {
    const a: PeopleAddress = parsePeopleAddress(reader({ show: '90' }), 'management');
    expect(peoplePushes(a, patchPeople(a, { person: 'u-ravi' }))).toBe(true);
    expect(peoplePushes(a, patchPeople(a, { add: true }))).toBe(true);
    expect(peoplePushes(patchPeople(a, { person: 'u-ravi' }), a)).toBe(false);
    expect(peoplePushes(patchPeople(a, { add: true }), a)).toBe(false);
    expect(peoplePushes(a, patchPeople(a, { q: 'x' }))).toBe(false);
    expect(patchPeople(a, { q: 'x' }).show).toBe(30);
    expect(peopleKey(a, 'management')).toBe(peopleKey(patchPeople(a, { person: 'u-ravi' }), 'management'));
  });

  it('sends status only for management', () => {
    const a = parsePeopleAddress(reader({ status: 'all', sort: 'name' }), 'management');
    expect(peopleQuery(a, 'management', 0, 30)).toEqual({ sort: 'name', dir: 'asc', offset: 0, limit: 30 });
    const d = parsePeopleAddress(reader({ role: 'finance' }), 'directory');
    expect(peopleQuery(d, 'directory', 30, 30)).toEqual({ role: ['finance'], offset: 30, limit: 30 });
  });
});

describe('PeopleSession: the directory', () => {
  it('lists active people only, with no administrator fields, chips or actions', async () => {
    const h = peopleHarness('directory');
    await h.start();
    const s = h.session;
    expect(s.rows.items.map((p) => p.displayName)).toEqual(['Asha Shetty', 'Meena Iyer', 'Ravi Kumar']);
    for (const p of s.rows.items) {
      const row = personRow(p, 'directory', s.meta);
      expect(row.actions).toEqual([]);
      expect(row.badge).toBeUndefined();
      expect(JSON.stringify(row)).not.toMatch(/Invited|Suspended|Two-step|twoStep|joined/i);
    }
    expect(peopleColumns('directory').map((c) => c.key)).toEqual(['name', 'email', 'roles']);
    expect(s.meta.counts).toBeUndefined();
    const sections = directorySections(s.rows.items[2]!, s.meta);
    expect(sections.map((x) => x.id)).toEqual(['contact', 'roles']);
  });

  it('refuses every change without asking the server', async () => {
    const h = peopleHarness('directory');
    await h.start();
    const before = h.g.calls.length;
    for (const out of [await h.session.suspend('u-ravi'), await h.session.resend('u-ravi'), await h.session.setRoles('u-ravi', []), await h.session.bulk('resend')]) expect(out.ok).toBe(false);
    h.session.openAdd();
    h.session.check('u-ravi');
    h.session.selectChip('invited');
    expect(h.g.calls.length).toBe(before);
    expect(h.session.selection.ids).toEqual([]);
    expect(h.urls).toEqual([]);
  });

  it('filters the directory by role', async () => {
    const h = peopleHarness('directory', { role: 'viewer' });
    await h.start();
    expect(h.session.state.role).toEqual(['viewer']);
    expect(h.session.rows.items.map((p) => p.displayName)).toEqual(['Meena Iyer']);
    h.session.removeFilter('role');
    await h.settle();
    expect(h.urls.at(-1)).toEqual({ params: expect.objectContaining({ role: null }), replace: true });
    expect(h.session.rows.items).toHaveLength(3);
  });

  it('opens a person read-only with a new history entry', async () => {
    const h = peopleHarness('directory');
    await h.start();
    h.session.open('u-ravi');
    expect(h.urls.at(-1)).toEqual({ params: expect.objectContaining({ person: 'u-ravi' }), replace: false });
    expect((await h.session.person('u-ravi'))!.status).toBeUndefined();
  });
});

describe('PeopleSession: management', () => {
  it('opens on Active with status chips and counts, and the row ⋮ for each person', async () => {
    const h = peopleHarness('management');
    await h.start();
    const s = h.session;
    expect(s.rows.items.map((p) => p.userId)).toEqual(['u-asha', 'u-meena', 'u-ravi']);
    expect(statusChips(s.meta.counts).map((c) => c.label)).toEqual(['Active 3', 'Invited 1', 'Suspended 1', 'All 5']);
    expect(personRow(s.rows.items[2]!, 'management', s.meta).actions.map((a) => a.id)).toEqual(['roles', 'resend', 'suspend']);
    expect(peopleColumns('management').map((c) => c.key)).toEqual(['name', 'roles', 'twoStep', 'status', 'joined']);
    expect(personRow(s.rows.items[2]!, 'management', s.meta).cells.find((c) => c.key === 'twoStep')!.value).toBe('Required · not set');
    s.selectChip('suspended');
    await h.settle();
    expect(s.rows.items.map((p) => p.userId)).toEqual(['u-deepak']);
    expect(personRow(s.rows.items[0]!, 'management', s.meta).actions.map((a) => a.id)).toEqual(['reactivate']);
  });

  it('adds a person and switches to Invited; a duplicate shows the server message under the field', async () => {
    const h = peopleHarness('management', { add: '' });
    await h.start();
    expect(h.session.state.add).toBe(true);
    const out = await h.session.add({ email: 'kavya@ashatrust.org', displayName: 'Kavya Rao', roles: ['finance'], invite: true });
    expect(out).toMatchObject({ ok: true, message: 'Kavya Rao added. Invitation sent.' });
    await h.settle();
    expect(h.params()).toMatchObject({ status: 'invited' });
    expect(h.params()).not.toHaveProperty('add');
    expect(h.session.rows.items.map((p) => p.displayName)).toEqual(['Farhan Ali', 'Kavya Rao']);
    const dup = await h.session.add({ email: 'kavya@ashatrust.org', displayName: 'Kavya Rao', roles: [], invite: false });
    expect(dup).toMatchObject({ ok: false, message: 'Kavya Rao (kavya@ashatrust.org) is already a member.', issues: [{ path: 'email', message: 'Already a member.' }] });
  });

  it('resends, suspends and reactivates, updating the list', async () => {
    const h = peopleHarness('management');
    await h.start();
    expect(await h.session.resend('u-ravi')).toEqual({ ok: true, message: 'Invitation sent to Ravi Kumar.' });
    expect(await h.session.suspend('u-ravi')).toEqual({ ok: true, message: 'Ravi Kumar suspended.' });
    await h.settle();
    expect(h.session.rows.items.map((p) => p.userId)).toEqual(['u-asha', 'u-meena']);
    expect(h.session.meta.counts).toMatchObject({ active: 2, suspended: 2 });
    expect(await h.session.reactivate('u-ravi')).toEqual({ ok: true, message: 'Ravi Kumar reactivated.' });
    expect(await h.session.resend('u-deepak')).toEqual({ ok: false, message: 'Reactivate them before sending an invitation.' });
  });

  it('changes roles and shows the lock-out refusal', async () => {
    const h = peopleHarness('management');
    await h.start();
    expect((await h.session.setRoles('u-ravi', ['viewer'])).ok).toBe(true);
    expect(await h.session.setRoles('u-asha', ['finance'])).toEqual({ ok: false, message: 'This would leave nobody who can manage roles.' });
    expect(h.g.people.find((p) => p.userId === 'u-asha')!.roles).toEqual(['admin', 'finance']);
  });

  it('selects people and runs bulk operations over the ticked rows', async () => {
    const h = peopleHarness('management');
    await h.start();
    h.session.check('u-meena');
    h.session.check('u-ravi');
    expect(h.session.selectedIds()).toEqual(['u-meena', 'u-ravi']);
    expect(await h.session.bulk('addRole')).toMatchObject({ ok: false });
    expect(await h.session.bulk('addRole', 'viewer')).toEqual({ ok: true, message: '2 done' });
    expect(h.g.people.find((p) => p.userId === 'u-ravi')!.roles).toEqual(['finance', 'viewer']);
    expect(h.session.selection.ids).toEqual([]);
    h.session.checkPage();
    expect(h.session.pageTicked()).toBe('all');
    const out = await h.session.bulk('removeRole', 'admin');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('This would leave nobody who can manage roles.');
  });
});
