import { describe, expect, it } from 'vitest';
import { memoryGateway, sampleSeed } from '../../testing/memory-gateway';
import { donorType } from '../../testing/sample-data';
import { queryBody } from '../list/query';
import { canShare, lastDay, shareLine, shareName, ShareSession, type SharesGateway } from './sharing';
import { resolveListSpec } from '../spec';
import { donationsView, donationType, donationWorkflow, paramsOf } from '../gateway/testing';
import { parseListUrl } from '../list/url';

const restricted = { ...donationType, visibility: 'restricted' as const };
const TODAY = '2026-10-20';

/** The sample organisation with donations restricted, Vikram (who created donation-4, not donation-1) signed in, and Meera in the field officers. */
function world() {
  const seed = sampleSeed();
  seed.users.push({ id: 'u3', displayName: 'Meera Iyer', email: 'meera@example.org', password: 'field visits daily', roles: ['field'] });
  seed.roles = [
    { key: 'admin', label: 'Administrators', permissions: ['*'] },
    { key: 'treasurer', label: 'Treasurers', permissions: ['record:donation:read', 'record:donation:update'] },
    { key: 'field', label: 'Field officers', permissions: ['record:donation:read', 'record:donation:update'] },
  ];
  seed.definitions.recordTypes = seed.definitions.recordTypes.map((t) => (t.key === 'donation' ? { ...t, visibility: 'restricted' } : t));
  seed.me = 'u2';
  const g = memoryGateway(seed);
  const session = (gateway: SharesGateway = g.shares) => new ShareSession(gateway, 'donation', () => TODAY);
  return { g, session };
}

describe('the "Shared with me" chip', () => {
  it('is added to restricted record types only, after the list view chips, and filters by shares', () => {
    const spec = resolveListSpec(restricted, donationWorkflow, donationsView);
    expect(spec.chips.at(-1)).toEqual({ id: 'shared', label: 'Shared with me', sharedWithMe: true });
    expect(spec.chips.filter((c) => c.sharedWithMe)).toHaveLength(1);
    expect(queryBody(spec, parseListUrl(paramsOf({ chip: 'shared' }), spec), 0, 20)).toMatchObject({ sharedWithMe: true });
    expect(queryBody(spec, parseListUrl(paramsOf({ chip: 'mine' }), spec), 0, 20).sharedWithMe).toBeUndefined();

    expect(resolveListSpec(restricted, donationWorkflow).chips.map((c) => c.id)).toEqual(['all', 'raised', 'paid', 'shared']);
    expect(resolveListSpec(donationType, donationWorkflow, donationsView).chips.some((c) => c.sharedWithMe)).toBe(false);
    expect(resolveListSpec(donorType).chips.some((c) => c.sharedWithMe)).toBe(false);
  });

  it('keeps the server’s chip when the list view already has one, without adding another', () => {
    const view = { ...donationsView, chips: [...donationsView.chips!, { id: 'withMe', label: 'With me', shared: true }] };
    const spec = resolveListSpec(restricted, donationWorkflow, view);
    expect(spec.chips.filter((c) => c.sharedWithMe)).toEqual([{ id: 'withMe', label: 'With me', statusIn: undefined, owner: undefined, sharedWithMe: true }]);
  });
});

describe('who sees Share', () => {
  it('opens the share panel from the address only on restricted record types', () => {
    const spec = resolveListSpec(restricted, donationWorkflow, donationsView);
    expect(parseListUrl(paramsOf({ id: 'donation-4', panel: 'share' }), spec).panel).toEqual({ kind: 'share' });
    const open = resolveListSpec(donationType, donationWorkflow, donationsView);
    expect(parseListUrl(paramsOf({ id: 'donation-4', panel: 'share' }), open).panel).toEqual({ kind: 'view' });
  });

  it('offers Share on restricted records the person created or may share', async () => {
    const { g } = world();
    const spec = resolveListSpec(restricted, donationWorkflow, donationsView);
    expect(canShare(spec, await g.records.get('donation', 'donation-4'))).toBe(true);
    expect(canShare(spec, await g.records.get('donation', 'donation-1'))).toBe(false);
    const listed = await g.records.query('donation', { limit: 50 });
    expect(listed.items.filter((r) => r.canShare).map((r) => r.id).sort()).toEqual(['donation-10', 'donation-3', 'donation-4', 'donation-6', 'donation-8']);
    expect(canShare(resolveListSpec(donationType, donationWorkflow, donationsView), await g.records.get('donation', 'donation-4'))).toBe(false);
  });
});

describe('share session', () => {
  it('lists, adds a person and a role with read or edit and an end, changes one, and removes one', async () => {
    const { g, session } = world();
    const s = session();
    await s.open('donation-4');
    expect(s.snapshot).toMatchObject({ shares: [], loading: false, error: '' });

    const [meera, ...rest] = await s.source.search('mee');
    expect(rest).toEqual([]);
    expect(meera).toEqual({ id: 'user:u3', label: 'Meera Iyer', hint: 'meera@example.org' });
    s.choose(meera!);
    s.setExpiry('2027-03-31');
    expect(await s.share()).toBe(true);
    const [first] = s.snapshot.shares;
    expect(first).toMatchObject({ principalKind: 'user', principal: 'u3', name: 'Meera Iyer', access: 'read', createdBy: 'u2', expiresAt: '2027-04-01T00:00:00.000Z' });
    expect(lastDay(first!.expiresAt)).toBe('2027-03-31');
    expect(shareLine(first!)).toBe('Can view · until 31 Mar 2027');
    expect(s.snapshot.message).toBe('Shared with Meera Iyer (Can view · until 31 Mar 2027).');
    expect(s.snapshot.draft).toEqual({ chosen: null, access: 'read', expiresOn: '' });

    const [role] = await s.source.search('field');
    expect(role).toEqual({ id: 'role:field', label: 'Field officers', hint: 'role' });
    s.choose(role!);
    s.setAccess('edit');
    expect(await s.share()).toBe(true);
    const fieldShare = s.snapshot.shares[1]!;
    expect(fieldShare).toMatchObject({ principalKind: 'role', principal: 'field', access: 'edit', expiresAt: null });
    expect([shareName(fieldShare), shareLine(fieldShare)]).toEqual(['Field officers (role)', 'Can edit · no end date']);

    s.choose((await s.source.search('meera'))[0]!);
    s.setAccess('edit');
    await s.share();
    expect(s.snapshot.shares.map((x) => [x.principal, x.access, x.expiresAt])).toEqual([
      ['u3', 'edit', null],
      ['field', 'edit', null],
    ]);
    expect(g.calls.filter((c) => c.port === 'shares' && c.op === 'share').map((c) => c.args[2])).toEqual([
      { principalKind: 'user', principal: 'u3', access: 'read', expiresAt: '2027-03-31' },
      { principalKind: 'role', principal: 'field', access: 'edit' },
      { principalKind: 'user', principal: 'u3', access: 'edit' },
    ]);

    await s.remove(fieldShare.id);
    expect(s.snapshot.shares.map((x) => x.principal)).toEqual(['u3']);
    expect(s.snapshot.message).toBe('Stopped sharing with Field officers (role).');

    const reopened = session();
    await reopened.open('donation-4');
    expect(reopened.snapshot.shares.map((x) => x.principal)).toEqual(['u3']);
  });

  it('lists the record under "Shared with me" for the person it was shared with', async () => {
    const { g, session } = world();
    const s = session();
    await s.open('donation-4');
    s.choose((await s.source.search('meera'))[0]!);
    await s.share();
    await g.auth.login({ tenant: 'seva', email: 'meera@example.org', password: 'field visits daily' });
    const spec = resolveListSpec(restricted, donationWorkflow, donationsView);
    const shared = await g.records.query('donation', queryBody(spec, parseListUrl(paramsOf({ chip: 'shared' }), spec), 0, 20));
    expect(shared.items.map((r) => r.id)).toEqual(['donation-4']);
  });

  it('asks for a person or role and a day from today on before asking the server', async () => {
    const { g, session } = world();
    const s = session();
    await s.open('donation-4');
    expect(await s.share()).toBe(false);
    expect(s.snapshot.errors).toEqual({ principal: 'Choose a person or role.' });
    s.choose((await s.source.search('meera'))[0]!);
    expect(s.snapshot.errors).toEqual({});
    s.setExpiry('2026-10-19');
    expect(await s.share()).toBe(false);
    expect(s.snapshot.errors).toEqual({ expiresOn: 'Choose today or a later day.' });
    expect(g.calls.some((c) => c.op === 'share')).toBe(false);
    s.setExpiry(TODAY);
    expect(await s.share()).toBe(true);
  });

  it('shows the server’s problems by part, or as one message', async () => {
    const { g, session } = world();
    const refusing = (error: unknown): SharesGateway => ({ ...g.shares, share: () => Promise.reject(error) });
    const s = session(refusing({ code: 'invalid', message: 'The share is not valid.', issues: [{ path: '/principal', message: 'is not a member of this organisation' }] }));
    await s.open('donation-4');
    s.choose((await s.source.search('meera'))[0]!);
    expect(await s.share()).toBe(false);
    expect(s.snapshot).toMatchObject({ errors: { principal: 'is not a member of this organisation' }, error: '', busy: false });
    expect(s.snapshot.draft.chosen?.principal).toBe('u3');

    const rule = session(refusing({ code: 'rule_violation', message: 'Donation records are visible to everyone who may see them, so they are not shared.' }));
    await rule.open('donation-4');
    rule.choose((await rule.source.search('meera'))[0]!);
    await rule.share();
    expect(rule.snapshot).toMatchObject({ errors: {}, error: 'Donation records are visible to everyone who may see them, so they are not shared.' });
  });

  it('says when the share gives the person or role nothing, because their roles cannot see or edit the type', async () => {
    const seed = sampleSeed();
    seed.users.push(
      { id: 'u3', displayName: 'Meera Iyer', email: 'meera@example.org', password: 'field visits daily', roles: ['field'] },
      { id: 'u4', displayName: 'Nina Neighbour', email: 'nina@example.org', password: 'two doors along', roles: ['visitors'] },
    );
    seed.roles = [
      { key: 'admin', label: 'Administrators', permissions: ['*'] },
      { key: 'treasurer', label: 'Treasurers', permissions: ['record:donation:read', 'record:donation:update'] },
      { key: 'field', label: 'Field officers', permissions: ['record:donation:read'] },
      { key: 'visitors', label: 'Visitors', permissions: [] },
    ];
    seed.definitions.recordTypes = seed.definitions.recordTypes.map((t) => (t.key === 'donation' ? { ...t, visibility: 'restricted' } : t));
    seed.me = 'u2';
    const g = memoryGateway(seed);
    const s = new ShareSession(g.shares, 'donation', () => TODAY);
    await s.open('donation-4');

    s.choose((await s.source.search('nina'))[0]!);
    expect(s.snapshot.warning).toBe(
      'Nina Neighbour cannot see records of this kind, so this share gives no access. An administrator has to give their role See on this record type first.',
    );

    s.choose((await s.source.search('meera'))[0]!);
    expect(s.snapshot.warning).toBe('');
    s.setAccess('edit');
    expect(s.snapshot.warning).toBe(
      'Meera Iyer cannot edit records of this kind, so a Can edit share lets them view only. An administrator has to give their role Edit on this record type first.',
    );
    s.choose((await s.source.search('field'))[0]!);
    expect(s.snapshot.warning).toContain('Field officers (role) cannot edit records of this kind');

    expect(await s.share()).toBe(true);
    expect(s.snapshot.message).toBe('Shared with Field officers (role) (Can edit · no end date).');
    expect(s.snapshot.warning).toContain('Field officers (role) cannot edit records of this kind');

    s.choose((await s.source.search('treasurer'))[0]!);
    s.setAccess('edit');
    expect(s.snapshot.warning).toBe('');
  });

  it('reports a record the person may not share, and a removal that fails', async () => {
    const { g, session } = world();
    const s = session();
    await s.open('donation-1');
    expect(s.snapshot).toMatchObject({ loading: false, shares: [], error: 'Only its creator or people allowed to share can share this record.' });

    const flaky = session({ ...g.shares, remove: () => Promise.reject({ code: 'not_found', message: 'Share not found.' }) });
    await flaky.open('donation-4');
    flaky.choose((await flaky.source.search('meera'))[0]!);
    await flaky.share();
    await flaky.remove(flaky.snapshot.shares[0]!.id);
    expect(flaky.snapshot).toMatchObject({ error: 'Share not found.', busy: false });
    expect(flaky.snapshot.shares).toHaveLength(1);
  });
});
