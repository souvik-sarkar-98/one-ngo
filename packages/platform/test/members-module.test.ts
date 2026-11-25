import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareDeployment } from '../src/prepare-deployment.js';
import { organisationToday } from '../src/shared/time/organisation-time.js';
import { createWorld, type TestWorld } from './helpers.js';

const MODULES_DIR = join(import.meta.dirname, '../../product/modules');
const folders = readdirSync(MODULES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

let w: TestWorld;

beforeAll(async () => {
  w = await createWorld({ donations: false });
  const deployed = await prepareDeployment(w.platform.db, { shippedModules: folders });
  const ctx = w.as(w.ngoA);
  for (const key of ['donations', 'members']) await w.platform.definitions.enableModule(ctx, deployed.modules.find((m) => m.manifest.key === key)!.manifest);
}, 120_000);
afterAll(() => w.close());

describe('the member record', () => {
  it('takes name, email and joined day from the person, works out first and last name, and needs a phone number', async () => {
    const ctx = w.as(w.ngoA);
    const { userId } = await w.platform.people.add(ctx, { email: 'asha.member@example.org', displayName: '  Asha  Kumari Rao ', roles: [] });
    const joined = await w.platform.db.withTenant(w.ngoA, async (tx) => (await tx.query<{ joined_at: string }>(`select joined_at from tenant_member where user_id = $1`, [userId]))[0]!.joined_at);

    await expect(w.platform.records.create(ctx, 'member', { login: userId })).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: '/phone' })]) });

    const created = await w.platform.records.create(ctx, 'member', { login: userId, phone: '+91 98765 43210', designation: 'Treasurer', city: 'Bengaluru' });
    expect(created.record.data).toMatchObject({
      name: expect.stringContaining('Asha'),
      email: 'asha.member@example.org',
      joinedOn: organisationToday(new Date(joined)),
      firstName: 'Asha',
      middleName: 'Kumari',
      lastName: 'Rao',
      designation: 'Treasurer',
    });
    expect(created.record.data.memberId).toMatch(/^NM\d{4}AR\d{3}$/);
    expect(created.record.data).not.toHaveProperty('category');
  });

  it('suggests the name parts, keeps a name part the person typed, and leaves the rest alone on later saves', async () => {
    const ctx = w.as(w.ngoA);
    const { userId } = await w.platform.people.add(ctx, { email: 'ravi.parts@example.org', displayName: 'Ravi Shankar Iyer', roles: [] });
    const typed = await w.platform.records.create(ctx, 'member', { login: userId, phone: '+91 98000 00001', firstName: 'Ravi K.' });
    expect(typed.record.data).toMatchObject({ firstName: 'Ravi K.', middleName: 'Shankar', lastName: 'Iyer' });
    await w.platform.records.update(ctx, typed.record.id, { expectedVersion: typed.record.version, data: { lastName: 'Iyer-Rao' } });
    const after = await w.platform.records.get(ctx, typed.record.id);
    expect(after.data).toMatchObject({ firstName: 'Ravi K.', middleName: 'Shankar', lastName: 'Iyer-Rao' });
  });

  it('raises the membership fee by itself when a fee amount is given, and none otherwise', async () => {
    const ctx = w.as(w.ngoA);
    const { userId } = await w.platform.people.add(ctx, { email: 'fee.member@example.org', displayName: 'Fee Payer', roles: [] });
    const created = await w.platform.records.create(ctx, 'member', { login: userId, phone: '+91 98111 11111', joiningFee: 500 });
    await w.platform.dispatcher.runOnce();
    const fees = await w.platform.records.list(ctx, 'membershipFee');
    const mine = fees.filter((f) => f.data.member === created.record.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.data).toMatchObject({ amount: 500, memberName: expect.stringContaining('Fee Payer'), memberEmail: 'fee.member@example.org' });
    expect(mine[0]!.status).toBe('raised');

    const other = await w.platform.people.add(ctx, { email: 'nofee.member@example.org', displayName: 'No Fee', roles: [] });
    const without = await w.platform.records.create(ctx, 'member', { login: other.userId, phone: '+91 98222 22222' });
    await w.platform.dispatcher.runOnce();
    const after = await w.platform.records.list(ctx, 'membershipFee');
    expect(after.filter((f) => f.data.member === without.record.id)).toHaveLength(0);
  });

  it('lets only an administrator create members; the membership manager can still read, edit and move them', async () => {
    const deployed = await w.platform.db.withTenant(w.ngoA, (tx) => tx.query<{ permissions: string[] }>(`select permissions from role where key = 'membership-manager'`));
    const permissions = deployed[0]!.permissions;
    expect(permissions).not.toContain('record:member:*');
    expect(permissions).not.toContain('record:member:create');
    expect(permissions).toEqual(expect.arrayContaining(['record:member:read', 'record:member:update', 'record:member:transition:*']));
  });

  it('leaves the last name blank for a one-word name', async () => {
    const ctx = w.as(w.ngoA);
    const { userId } = await w.platform.people.add(ctx, { email: 'single.member@example.org', displayName: 'Madonna', roles: [] });
    const created = await w.platform.records.create(ctx, 'member', { login: userId, phone: '+44 20 7946 0958' });
    expect(created.record.data).toMatchObject({ name: 'Madonna', firstName: 'Madonna' });
    expect(created.record.data.lastName ?? '').toBe('');
  });
});
