import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import type { Actor } from '../src/infrastructure/postgres/db.js';
import { sharingPermissionsByType } from '../src/runtime/definitions/record-permissions.js';
import type { DefinitionKind, ListViewDef } from '../src/runtime/definitions/types.js';
import type { ShareCandidate } from '../src/runtime/records/shares.js';
import { admin, createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let app: FastifyInstance;

const BASE = ['record:case:read', 'record:case:update', 'record:case:transition:*', 'record:case:action:*'];
const people: Record<string, Actor> = {};

const publish = async (kind: DefinitionKind, body: Record<string, unknown>) => {
  await w.platform.definitions.saveDraft(w.as(w.ngoA), kind, body as never);
  await w.platform.definitions.publish(w.as(w.ngoA), kind, String(body.key));
};
/** A real member of the organisation, so notifications reach them. */
async function person(name: string, extra: string[] = [], roles: string[] = []): Promise<Actor> {
  const [u] = await w.platform.db.asSystem((tx) =>
    tx.query<{ id: string }>(`insert into app_user (email, display_name) values ($1, $2) returning id`, [`${name.toLowerCase().replace(/ /g, '.')}@example.org`, name]),
  );
  await w.platform.db.asSystem(async (tx) => {
    await tx.query(`insert into tenant_member (tenant_id, user_id) values ($1, $2)`, [w.ngoA, u!.id]);
    for (const r of roles) await tx.query(`insert into role_assignment (tenant_id, user_id, role_key) values ($1, $2, $3)`, [w.ngoA, u!.id, r]);
  });
  return { id: u!.id, roles, permissions: [...BASE, ...extra] };
}
const headers = (actor: Actor) => ({ 'x-dev-tenant': w.ngoA, 'x-dev-actor': JSON.stringify(actor) });
const shares = (actor: Actor, id: string, method: 'GET' | 'POST' = 'GET', payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/records/case/${id}/shares`, headers: headers(actor), payload });
const inbox = (actor: Actor) => w.platform.notifications.inbox(w.as(w.ngoA, actor));
const version = async (id: string) => (await w.platform.records.get(w.as(w.ngoA), id)).version;

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  app = buildServer(w.platform, { devAuth: true });
  await w.platform.db.asSystem((tx) =>
    tx.query(
      `insert into role (tenant_id, key, label, permissions) values
         ($1, 'caseworkers', 'Caseworkers', array['record:case:read']),
         ($1, 'auditors', 'Auditors', array['record:case:read', 'record:case:update']),
         ($1, 'approvers', 'Approvers', array[]::text[])`,
      [w.ngoA],
    ),
  );
  await publish('recordType', {
    key: 'case',
    label: 'Case',
    titleField: 'title',
    visibility: 'restricted',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'notes', label: 'Notes', type: 'text' },
      { key: 'attachment', label: 'Attachment', type: 'file' },
    ],
  });
  await publish('workflow', {
    key: 'case',
    recordType: 'case',
    initial: 'open',
    states: [
      { key: 'open', label: 'Open' },
      { key: 'held', label: 'On hold' },
      { key: 'approved', label: 'Approved' },
    ],
    transitions: [
      { key: 'hold', label: 'Hold', from: ['open'], to: 'held' },
      { key: 'resume', label: 'Resume', from: ['held'], to: 'open' },
      { key: 'approve', label: 'Approve', from: ['open', 'held'], to: 'approved', approval: { roles: ['approvers'] } },
    ],
  });
  await publish('action', { key: 'stamp', recordType: 'case', label: 'Stamp', placement: ['panel'], steps: [{ type: 'setFields', values: { notes: "'stamped'" } }] });
  await publish('action', {
    key: 'remind',
    recordType: 'case',
    label: 'Remind',
    placement: ['panel'],
    steps: [{ type: 'notify', template: 'donationReminder', to: { creator: true }, channels: ['inApp'] }],
  });
  await publish('listView', { key: 'cases', recordType: 'case', chips: [{ id: 'mine', label: 'Mine', owner: 'me' }] });

  people.author = await person('Asha Author', ['record:case:create'], ['caseworkers']);
  people.other = await person('Omar Other', ['record:case:create']);
  people.friend = await person('Farah Friend');
  people.roleMember = await person('Ravi Role', [], ['caseworkers']);
  people.late = await person('Lata Late');
  people.boss = await person('Bina Boss', ['record:case:read:all']);
  people.approver = await person('Arun Approver', [], ['approvers']);
  people.nosy = await person('Neel Nosy');
  people.sharer = await person('Sona Sharer', ['record:case:read:all', 'record:case:share']);
});
afterAll(async () => {
  await app.close();
  await w.close();
});

describe('restricted visibility on every read path', () => {
  it('lets the creator, shares by person and role, read:all and approvers through, and nobody else', async () => {
    const { author, other, friend, roleMember, late, boss, approver, nosy } = people;
    const file = await w.platform.files.upload(w.as(w.ngoA, author!), { body: [Buffer.from('Visit notes, all fine.\n')], name: 'visit.txt', recordType: 'case', field: 'attachment' });
    const target = (await w.platform.records.create(w.as(w.ngoA, author!), 'case', { title: 'Flood relief', amount: 100, attachment: file.id })).record;
    await w.platform.records.create(w.as(w.ngoA, other!), 'case', { title: 'Hidden', amount: 40 });

    expect((await shares(author!, target.id, 'POST', { principalKind: 'user', principal: friend!.id, access: 'read' })).statusCode).toBe(201);
    expect((await shares(author!, target.id, 'POST', { principalKind: 'role', principal: 'caseworkers', access: 'edit' })).statusCode).toBe(201);
    expect((await shares(author!, target.id, 'POST', { principalKind: 'user', principal: late!.id, access: 'edit' })).statusCode).toBe(201);
    await w.platform.db.withTenant(w.ngoA, (tx) =>
      tx.query(`update record_share set expires_at = now() - interval '1 minute' where record_id = $1 and principal = $2`, [target.id, late!.id]),
    );
    const requested = await w.platform.records.transition(w.as(w.ngoA, author!), target.id, 'approve', { expectedVersion: target.version });
    expect(requested.approvalRequestId).toBeTruthy();

    type Expect = { sees: boolean; edits: boolean; total: number; sum: number };
    const cases: [string, Actor, Expect][] = [
      ['creator', author!, { sees: true, edits: true, total: 1, sum: 100 }],
      ['share by person (read)', friend!, { sees: true, edits: false, total: 1, sum: 100 }],
      ['share by role (edit)', roleMember!, { sees: true, edits: true, total: 1, sum: 100 }],
      ['expired share', late!, { sees: false, edits: false, total: 0, sum: 0 }],
      ['read:all', boss!, { sees: true, edits: true, total: 2, sum: 140 }],
      ['approver', approver!, { sees: true, edits: false, total: 1, sum: 100 }],
      ['nobody', nosy!, { sees: false, edits: false, total: 0, sum: 0 }],
    ];
    for (const [who, actor, e] of cases) {
      const ctx = w.as(w.ngoA, actor);
      const hidden = async (p: Promise<unknown>) => expectCode(p, 'not_found');

      if (e.sees) expect((await w.platform.records.get(ctx, target.id)).data.title, who).toBe('Flood relief');
      else await hidden(w.platform.records.get(ctx, target.id));

      const listed = await w.platform.records.query(ctx, 'case', { sum: ['amount'] });
      expect(listed.items.some((r) => r.id === target.id), who).toBe(e.sees);
      expect({ total: listed.total, sums: listed.sums }, who).toEqual({ total: e.total, sums: { amount: e.sum } });
      expect(await w.platform.aggregates.aggregate(ctx, 'case', { measure: 'sum', field: 'amount' }), who).toEqual({ value: e.sum });
      expect(await w.platform.aggregates.aggregate(ctx, 'case', { measure: 'count' }), who).toEqual({ value: e.total });

      const download = await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: headers(actor) });
      expect(download.statusCode, who).toBe(e.sees ? 200 : 404);
      if (e.sees) expect(download.body, who).toBe('Visit notes, all fine.\n');

      const remind = w.platform.actions.run(ctx, 'case', target.id, 'remind');
      if (e.sees) expect((await remind).message, who).toBe('Remind: done.');
      else await hidden(remind);

      const stamp = w.platform.actions.run(ctx, 'case', target.id, 'stamp');
      if (e.edits) expect((await stamp).record.data.notes, who).toBe('stamped');
      else await hidden(stamp);

      const update = w.platform.records.update(ctx, target.id, { data: { notes: who }, expectedVersion: await version(target.id) });
      if (e.edits) expect((await update).record.data.notes, who).toBe(who);
      else await hidden(update);

      for (const step of ['hold', 'resume']) {
        const moved = w.platform.records.transition(ctx, target.id, step, { expectedVersion: await version(target.id) });
        if (e.edits) expect((await moved).record.status, who).toBe(step === 'hold' ? 'held' : 'open');
        else await hidden(moved);
      }
    }
  });
});

describe('share routes', () => {
  let caseId: string;
  beforeAll(async () => {
    caseId = (await w.platform.records.create(w.as(w.ngoA, people.author!), 'case', { title: 'School fees', amount: 30 })).record.id;
  });

  it('let the creator and people with the share permission manage shares, and nobody else', async () => {
    const { author, friend, boss, sharer, nosy } = people;
    const created = await shares(author!, caseId, 'POST', { principalKind: 'user', principal: friend!.id, access: 'read' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ principalKind: 'user', principal: friend!.id, name: 'Farah Friend', access: 'read', createdBy: author!.id, expiresAt: null });

    expect((await shares(boss!, caseId)).statusCode).toBe(403);
    expect((await shares(boss!, caseId, 'POST', { principalKind: 'user', principal: nosy!.id, access: 'read' })).statusCode).toBe(403);
    expect((await shares(friend!, caseId, 'POST', { principalKind: 'user', principal: nosy!.id, access: 'read' })).statusCode).toBe(403);
    expect((await shares(nosy!, caseId)).statusCode).toBe(404);
    expect((await shares({ ...nosy!, permissions: [...nosy!.permissions, 'record:case:share'] }, caseId)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/records/donation/${caseId}/shares`, headers: headers(admin) })).statusCode).toBe(404);

    const bySharer = await shares(sharer!, caseId, 'POST', { principalKind: 'role', principal: 'auditors', access: 'edit', expiresAt: '2999-12-31' });
    expect(bySharer.statusCode).toBe(201);
    expect(bySharer.json()).toMatchObject({ principalKind: 'role', principal: 'auditors', name: 'Auditors', access: 'edit', expiresAt: '3000-01-01T00:00:00.000Z' });

    const list = (await shares(author!, caseId)).json() as { principal: string }[];
    expect(list.map((s) => s.principal)).toEqual([friend!.id, 'auditors']);
  });

  it('refuse unknown principal kinds, bad access, past or malformed ends, and unknown people or roles', async () => {
    const { author, friend } = people;
    const refused = async (body: Record<string, unknown>, path: string) => {
      const res = await shares(author!, caseId, 'POST', { principalKind: 'user', principal: friend!.id, access: 'read', ...body });
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
      expect(res.json().issues.map((i: { path: string }) => i.path), JSON.stringify(body)).toContain(path);
    };
    await refused({ principalKind: 'team' }, '/principalKind');
    await refused({ access: 'owner' }, '/access');
    await refused({ expiresAt: '2000-01-01' }, '/expiresAt');
    await refused({ expiresAt: new Date(Date.now() - 60_000).toISOString() }, '/expiresAt');
    await refused({ expiresAt: 'next week' }, '/expiresAt');
    await refused({ expiresAt: '2999-02-30' }, '/expiresAt');
    await refused({ principal: '' }, '/principal');
    await refused({ principal: '00000000-0000-4000-8000-000000000000' }, '/principal');
    await refused({ principalKind: 'role', principal: 'ghosts' }, '/principal');

    const donation = (await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Meera', amount: 500 })).record;
    const open = await app.inject({
      method: 'POST',
      url: `/api/records/donation/${donation.id}/shares`,
      headers: headers(admin),
      payload: { principalKind: 'user', principal: friend!.id, access: 'read' },
    });
    expect(open.json()).toMatchObject({ code: 'rule_violation' });
  });

  it('notify the person, or every member of the role except the sharer, once', async () => {
    const { author, friend, roleMember } = people;
    const fresh = (await w.platform.records.create(w.as(w.ngoA, author!), 'case', { title: 'Shelter repair' })).record;
    // The earlier test queued "remind" notifications for the author; the background dispatcher delivers them whenever it gets to them. Settle the outbox first so they cannot land mid-test.
    for (let i = 0; i < 20; i++) {
      await w.platform.dispatcher.runOnce();
      const [row] = await w.platform.db.asSystem((tx) => tx.query<{ n: string }>(`select count(*)::text as n from outbox_event where status <> 'done'`));
      if (row?.n === '0') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const before = { friend: (await inbox(friend!)).length, role: (await inbox(roleMember!)).length, author: (await inbox(author!)).length };

    await shares(author!, fresh.id, 'POST', { principalKind: 'user', principal: friend!.id, access: 'read', expiresAt: '2999-06-30' });
    const [note] = await inbox(friend!);
    expect(note).toMatchObject({ subject: 'Asha Author shared Case Shelter repair with you', body: 'You can see it until 2999-06-30.', recordId: fresh.id });
    await shares(author!, fresh.id, 'POST', { principalKind: 'user', principal: friend!.id, access: 'edit' });
    expect((await inbox(friend!)).length).toBe(before.friend + 1);

    await shares(author!, fresh.id, 'POST', { principalKind: 'role', principal: 'caseworkers', access: 'edit' });
    expect((await inbox(roleMember!))[0]).toMatchObject({ subject: 'Asha Author shared Case Shelter repair with you', body: 'You can see and edit it.', recordId: fresh.id });
    expect((await inbox(roleMember!)).length).toBe(before.role + 1);
    expect((await inbox(author!)).length).toBe(before.author);
  });

  it('remove a share, which hides the record again', async () => {
    const { author, friend } = people;
    const list = (await shares(author!, caseId)).json() as { id: string; principal: string }[];
    const mine = list.find((s) => s.principal === friend!.id)!;
    expect((await w.platform.records.get(w.as(w.ngoA, friend!), caseId)).id).toBe(caseId);

    const del = (id: string, actor = author!) => app.inject({ method: 'DELETE', url: `/api/records/case/${caseId}/shares/${id}`, headers: headers(actor) });
    expect((await del(mine.id, friend!)).statusCode).toBe(403);
    expect((await del(mine.id)).statusCode).toBe(204);
    expect((await del(mine.id)).statusCode).toBe(404);
    expect((await del('not-a-share')).statusCode).toBe(404);
    await expectCode(w.platform.records.get(w.as(w.ngoA, friend!), caseId), 'not_found');
    expect(((await shares(author!, caseId)).json() as unknown[]).length).toBe(list.length - 1);
  });
});

describe('sharing from the record panel', () => {
  let caseId: string;
  beforeAll(async () => {
    caseId = (await w.platform.records.create(w.as(w.ngoA, people.author!), 'case', { title: 'Well cleaning' })).record.id;
  });
  const candidates = (actor: Actor, q = '') =>
    app.inject({ method: 'GET', url: `/api/records/case/${caseId}/shares/candidates?q=${encodeURIComponent(q)}`, headers: headers(actor) });

  it('offers people and roles matching the text to the creator and sharers, without the person asking', async () => {
    const { author, sharer, friend, nosy } = people;
    const found = (await candidates(author!, 'fa')).json() as { items: { principalKind: string; principal: string; name: string; email?: string }[] };
    expect(found.items).toEqual([{ principalKind: 'user', principal: friend!.id, name: 'Farah Friend', email: 'farah.friend@example.org', canSee: false, canEdit: false }]);
    const roles = (await candidates(sharer!, 'case')).json() as { items: { principalKind: string; principal: string; name: string }[] };
    expect(roles.items).toEqual([{ principalKind: 'role', principal: 'caseworkers', name: 'Caseworkers', canSee: true, canEdit: false }]);
    const all = (await candidates(author!)).json() as { items: { principal: string }[] };
    expect(all.items.map((i) => i.principal)).not.toContain(author!.id);
    expect(all.items.length).toBeLessThanOrEqual(16);

    expect((await candidates(friend!)).statusCode).toBe(404);
    expect((await candidates(people.boss!)).statusCode).toBe(403);
    expect((await candidates(nosy!)).statusCode).toBe(404);
  });

  it('says of each candidate whether their roles let them see and edit the record type, so the panel can warn', async () => {
    const { author, friend, roleMember } = people;
    const items = ((await candidates(author!)).json() as { items: ShareCandidate[] }).items;
    const of = (principal: string) => items.find((i) => i.principal === principal);
    expect(of(friend!.id)).toMatchObject({ canSee: false, canEdit: false });
    expect(of(roleMember!.id)).toMatchObject({ canSee: true, canEdit: false });
    expect(of('caseworkers')).toMatchObject({ canSee: true, canEdit: false });
    expect(of('auditors')).toMatchObject({ canSee: true, canEdit: true });

    // A role that may see but not edit is the case the warning is for: the edit share leaves the record read-only.
    await w.platform.db.asSystem((tx) => tx.query(`insert into role (tenant_id, key, label, permissions) values ($1, 'viewers', 'Viewers', array['record:case:read'])`, [w.ngoA]));
    const viewer = { ...(await person('Vik Viewer', [], ['viewers'])), permissions: ['record:case:read'] };
    const own = (await w.platform.records.create(w.as(w.ngoA, author!), 'case', { title: 'Borehole survey' })).record;
    expect((await shares(author!, own.id, 'POST', { principalKind: 'role', principal: 'viewers', access: 'edit' })).statusCode).toBe(201);
    expect(((await candidates(author!, 'viewers')).json() as { items: ShareCandidate[] }).items).toEqual([
      { principalKind: 'role', principal: 'viewers', name: 'Viewers', canSee: true, canEdit: false },
    ]);
    expect((await w.platform.records.get(w.as(w.ngoA, viewer), own.id)).id).toBe(own.id);
    await expectCode(w.platform.records.update(w.as(w.ngoA, viewer), own.id, { data: { title: 'Mine now' }, expectedVersion: own.version }), 'forbidden');
  });

  it('marks restricted records the person may share', async () => {
    const { author, sharer, boss } = people;
    expect((await w.platform.records.get(w.as(w.ngoA, author!), caseId)).canShare).toBe(true);
    expect((await w.platform.records.get(w.as(w.ngoA, sharer!), caseId)).canShare).toBe(true);
    expect((await w.platform.records.get(w.as(w.ngoA, boss!), caseId)).canShare).toBeUndefined();
    const listed = await w.platform.records.query(w.as(w.ngoA, author!), 'case', {});
    expect(listed.items.find((r) => r.id === caseId)?.canShare).toBe(true);
    const donation = (await w.platform.records.create(w.as(w.ngoA), 'donation', { donorName: 'Meera', amount: 500 })).record;
    expect(donation.canShare).toBeUndefined();
  });
});

describe('shared with me', () => {
  it('lists records shared with the person or their roles, not their own', async () => {
    const { author, friend, roleMember } = people;
    const titles = async (actor: Actor) => {
      const res = await app.inject({ method: 'POST', url: '/api/records/case/query', headers: headers(actor), payload: { sharedWithMe: true } });
      return (res.json() as { items: { data: { title: string } }[] }).items.map((i) => i.data.title).sort();
    };
    expect(await titles(friend!)).toEqual(['Flood relief', 'Shelter repair']);
    expect(await titles(roleMember!)).toEqual(['Flood relief', 'Shelter repair']);
    expect(await titles(author!)).toEqual([]);
    expect(await w.platform.aggregates.aggregate(w.as(w.ngoA, friend!), 'case', { measure: 'count', sharedWithMe: true })).toEqual({ value: 2 });
  });

  it('adds a "Shared with me" chip to list views of restricted record types only', async () => {
    const defs = await w.platform.runtime.definitions(w.as(w.ngoA, people.friend!));
    expect((defs.listViews.case as ListViewDef).chips).toEqual([
      { id: 'mine', label: 'Mine', owner: 'me' },
      { id: 'shared', label: 'Shared with me', shared: true },
    ]);
    const donations = (await w.platform.runtime.definitions(w.as(w.ngoA))).listViews.donation as ListViewDef;
    expect(donations.chips!.some((c) => c.shared)).toBe(false);
  });

  it('lists See all and Share for restricted record types in the permission catalogue helper', async () => {
    const types = (await w.platform.definitions.list(w.ngoA, 'recordType')).map((t) => t.body);
    const perms = sharingPermissionsByType(types);
    expect(perms.case).toEqual([
      { key: 'read:all', permission: 'record:case:read:all' },
      { key: 'share', permission: 'record:case:share' },
    ]);
    expect(perms.donation).toBeUndefined();
  });
});
