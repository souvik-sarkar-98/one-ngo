import type { Params } from '../address';
import type { AddPersonInput, MemberStatus, PeopleListGateway, PeoplePage, PeopleQuery, PersonItem, RoleOption } from './people';
import { PeopleSession } from './people-session';
import type { PeopleVariant } from './address';

const ROLES: RoleOption[] = [
  { key: 'admin', label: 'Admin' },
  { key: 'finance', label: 'Finance' },
  { key: 'viewer', label: 'Viewer' },
];

type Seeded = Required<Pick<PersonItem, 'status' | 'twoStep' | 'joinedAt'>> & PersonItem;

/** Asha (admin), Ravi and Meena (active), Farhan (invited) and Deepak (suspended), as in Journey 21. */
export function peopleSeed(): Seeded[] {
  const p = (userId: string, displayName: string, roles: string[], status: MemberStatus, joined: string): Seeded => ({
    userId,
    displayName,
    email: `${displayName.split(' ')[0]!.toLowerCase()}@ashatrust.org`,
    roles,
    status,
    twoStep: roles.includes('finance') ? 'required-not-set' : 'off',
    joinedAt: joined,
    invitedAt: status === 'invited' ? '2026-10-21T10:00:00.000Z' : null,
    lastSignedInAt: status === 'invited' ? null : joined,
  });
  return [
    { ...p('u-asha', 'Asha Shetty', ['admin', 'finance'], 'active', '2026-04-02T00:00:00.000Z'), twoStep: 'on' },
    p('u-ravi', 'Ravi Kumar', ['finance'], 'active', '2026-08-14T00:00:00.000Z'),
    p('u-meena', 'Meena Iyer', ['finance', 'viewer'], 'active', '2026-09-03T00:00:00.000Z'),
    p('u-farhan', 'Farhan Ali', ['finance'], 'invited', '2026-10-21T00:00:00.000Z'),
    p('u-deepak', 'Deepak Joshi', ['viewer'], 'suspended', '2026-06-09T00:00:00.000Z'),
  ];
}

const fail = (code: string, message: string) => Object.assign(new Error(message), { code, issues: [] as { path: string; message: string }[] });

/** The People API in memory, with the server's rules that the screens rely on. */
export function memoryPeople(seed: Seeded[] = peopleSeed()) {
  const people = seed.map((p) => ({ ...p, roles: [...p.roles] }));
  const calls: { op: string; args: unknown[] }[] = [];
  const log = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const find = (id: string) => {
    const p = people.find((x) => x.userId === id);
    if (!p) throw fail('not_found', 'This person is not a member of the organisation.');
    return p;
  };
  const roleAdmins = () => people.filter((p) => p.status !== 'suspended' && p.roles.includes('admin')).length;
  const guard = (change: () => void, undo: () => void) => {
    change();
    if (!roleAdmins()) {
      undo();
      throw fail('rule_violation', 'This would leave nobody who can manage roles.');
    }
  };
  const view = ({ ...p }: Seeded): PersonItem => p;
  function filter(q: PeopleQuery, extra: (p: Seeded) => boolean) {
    const text = q.q?.toLowerCase();
    let out = people.filter(
      (p) =>
        extra(p) &&
        (!text || p.displayName.toLowerCase().includes(text) || p.email.includes(text)) &&
        (!q.role?.length || p.roles.some((r) => q.role!.includes(r))),
    );
    const dir = q.dir === 'desc' ? -1 : 1;
    const by = q.sort === 'joined' ? (p: Seeded) => p.joinedAt : q.sort === 'status' ? (p: Seeded) => ['active', 'invited', 'suspended'].indexOf(p.status) : (p: Seeded) => p.displayName;
    out = [...out].sort((a, b) => (by(a) < by(b) ? -dir : by(a) > by(b) ? dir : 0));
    return out;
  }
  const gateway: PeopleListGateway = {
    async directory(q) {
      log('directory', q);
      const all = filter(q, (p) => p.status === 'active');
      return {
        items: all.slice(q.offset, q.offset + q.limit).map((p) => ({
          userId: p.userId,
          displayName: p.displayName,
          email: p.email,
          roles: p.roles,
        })),
        total: all.length,
        roles: ROLES,
      };
    },
    async members(q) {
      log('members', q);
      const base = filter({ ...q, status: undefined }, () => true);
      const all = base.filter((p) => !q.status || q.status.includes(p.status));
      const counts = { active: 0, invited: 0, suspended: 0, all: base.length };
      for (const p of base) counts[p.status]++;
      return { items: all.slice(q.offset, q.offset + q.limit).map(view), total: all.length, roles: ROLES, counts } satisfies PeoplePage;
    },
    async member(id) {
      log('member', id);
      return view(find(id));
    },
    async add(input: AddPersonInput) {
      log('add', input);
      if (people.some((p) => p.email === input.email)) throw Object.assign(fail('conflict', `${input.displayName} (${input.email}) is already a member.`), { issues: [{ path: 'email', message: 'Already a member.' }] });
      const userId = `u-${people.length + 1}`;
      people.push({ userId, displayName: input.displayName, email: input.email, roles: input.roles, status: 'invited', twoStep: 'off', joinedAt: '2026-10-24T00:00:00.000Z', invitedAt: input.invite ? '2026-10-24T00:00:00.000Z' : null, lastSignedInAt: null });
      return { userId };
    },
    async invite(id) {
      log('invite', id);
      if (find(id).status === 'suspended') throw fail('conflict', 'Reactivate them before sending an invitation.');
    },
    async suspend(id) {
      log('suspend', id);
      if (id === 'u-asha') throw fail('validation_failed', 'You cannot suspend yourself.');
      const p = find(id);
      const was = p.status;
      guard(
        () => (p.status = 'suspended'),
        () => (p.status = was),
      );
      return view(p);
    },
    async reactivate(id) {
      log('reactivate', id);
      const p = find(id);
      if (p.status !== 'suspended') throw fail('conflict', `${p.displayName} is not suspended.`);
      p.status = p.lastSignedInAt ? 'active' : 'invited';
      return view(p);
    },
    async setRoles(id, roles) {
      log('setRoles', id, roles);
      const p = find(id);
      const was = p.roles;
      guard(
        () => (p.roles = [...roles]),
        () => (p.roles = was),
      );
      return view(p);
    },
    async addToRole(role, ids) {
      log('addToRole', role, ids);
      for (const id of ids) {
        const p = find(id);
        if (!p.roles.includes(role)) p.roles = [...p.roles, role];
      }
    },
    async removeFromRole(role, id) {
      log('removeFromRole', role, id);
      const p = find(id);
      const was = p.roles;
      guard(
        () => (p.roles = p.roles.filter((r) => r !== role)),
        () => (p.roles = was),
      );
    },
  };
  return { gateway, people, calls };
}

/** A People session over the memory gateway, wired to a fake address bar. */
export function peopleHarness(variant: PeopleVariant, start: Record<string, string> = {}) {
  const g = memoryPeople(peopleSeed());
  const urls: { params: Params; replace: boolean }[] = [];
  let params: Record<string, string> = { ...start };
  const read = () => session.fromUrl((name) => params[name] ?? null, Object.keys(params));
  const session = new PeopleSession(variant, g.gateway, {
    navigate: (next, replace) => {
      urls.push({ params: next, replace });
      params = Object.fromEntries(Object.entries({ ...params, ...next }).filter(([, v]) => v !== null)) as Record<string, string>;
      void read();
    },
  });
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { g, session, urls, settle, params: () => params, start: read };
}
