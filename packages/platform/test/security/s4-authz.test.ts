import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/infrastructure/postgres/db.js';
import { createWorld, expectCode, type TestWorld } from '../helpers.js';

/** S4-7 (grants), S4-10 (names per organisation) and S4-12 (jobs keep their creator's rights only while they hold them). */
let w: TestWorld;
const PERMISSION = 'probe:run';

beforeAll(async () => {
  w = await createWorld({ autoRunJobs: false });
  await w.platform.identity.upsertRole(w.as(w.ngoA), { key: 'runner', label: 'Runner', permissions: [PERMISSION] });
  await w.platform.identity.upsertRole(w.as(w.ngoA), { key: 'admin', label: 'Administrator', permissions: ['*'] });
  w.platform.jobs.register<Record<string, never>, Record<string, never>>('probe', {
    label: 'Probe',
    requires: () => PERMISSION,
    async run() {
      return { state: {}, progress: 1, total: 1, done: true };
    },
  });
});
afterAll(() => w.close());

async function runner(email: string): Promise<TenantContext> {
  const id = await w.platform.identity.addMember(w.as(w.ngoA), { email, displayName: email.split('@')[0]!, roles: ['runner'] });
  return { tenantId: w.ngoA, actor: { id, roles: ['runner'], permissions: [PERMISSION] } };
}
const finished = async (ctx: TenantContext, jobId: string) => {
  await w.platform.jobs.runOnce();
  return w.platform.jobs.get(ctx, jobId);
};

describe('S4-12 a job stops when its creator no longer holds what it needs', () => {
  it('runs for a creator who still holds the permission', async () => {
    const ctx = await runner('s412-ok@example.org');
    const job = await w.platform.jobs.create(ctx, 'probe', {});
    expect(await finished(ctx, job.id)).toMatchObject({ status: 'done' });
  });

  it('fails the job of a member who was suspended after starting it', async () => {
    const ctx = await runner('s412-suspended@example.org');
    const job = await w.platform.jobs.create(ctx, 'probe', {});
    await w.platform.people.suspend(w.as(w.ngoA), ctx.actor.id);
    expect(await finished(ctx, job.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('can no longer act') });
  });

  it('fails the job of a member whose role lost the permission', async () => {
    await w.platform.identity.upsertRole(w.as(w.ngoA), { key: 'short-lived', label: 'Short lived', permissions: [PERMISSION] });
    const id = await w.platform.identity.addMember(w.as(w.ngoA), { email: 's412-role@example.org', displayName: 'Role Loser', roles: ['short-lived'] });
    const ctx: TenantContext = { tenantId: w.ngoA, actor: { id, roles: ['short-lived'], permissions: [PERMISSION] } };
    const job = await w.platform.jobs.create(ctx, 'probe', {});
    await w.platform.identity.upsertRole(w.as(w.ngoA), { key: 'short-lived', label: 'Short lived', permissions: ['people:read'] });
    expect(await finished(ctx, job.id)).toMatchObject({ status: 'failed', error: expect.stringContaining(`no longer has the permission '${PERMISSION}'`) });
  });

  it('fails the job of an API key that was revoked after starting it', async () => {
    const key = await w.platform.apiKeys.create(w.as(w.ngoA), { name: 's412-key', role: 'runner' });
    const ctx: TenantContext = { tenantId: w.ngoA, actor: { id: 'api:s412-key', roles: ['runner'], permissions: [PERMISSION] } };
    const job = await w.platform.jobs.create(ctx, 'probe', {});
    await w.platform.apiKeys.revoke(w.as(w.ngoA), key.id);
    expect(await finished(ctx, job.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('revoked') });
  });
});

describe('S4-7 roles are only given by someone who holds what they allow', () => {
  it('lets a role manager give any role, and an API-key manager mint a key only for roles within their own permissions', async () => {
    const keys: TenantContext = { tenantId: w.ngoA, actor: { id: 'keys-desk', roles: [], permissions: ['admin:api-keys', PERMISSION] } };
    expect(await w.platform.apiKeys.create(keys, { name: 'within', role: 'runner' })).toMatchObject({ role: 'runner' });
    await expectCode(w.platform.apiKeys.create(keys, { name: 'beyond', role: 'admin' }), 'forbidden');
    const rolesAdmin: TenantContext = { tenantId: w.ngoA, actor: { id: 'roles-desk', roles: [], permissions: ['admin:api-keys', 'admin:roles'] } };
    expect(await w.platform.apiKeys.create(rolesAdmin, { name: 'by-role-admin', role: 'admin' })).toMatchObject({ role: 'admin' });
  });
});

describe('S4-10 each organisation keeps the name it typed', () => {
  it('does not change another organisation’s name for the same account', async () => {
    await w.platform.identity.addMember(w.as(w.ngoB), { email: 's410-shared@example.org', displayName: 'Bodhi Name', roles: [] });
    const added = await w.platform.people.add(w.as(w.ngoA), { email: 's410-shared@example.org', displayName: 'Asha Name', roles: [] });
    expect(added).toMatchObject({ email: 's410-shared@example.org', displayName: 'Asha Name', invited: false });
    expect((await w.platform.people.member(w.as(w.ngoA), added.userId)).displayName).toBe('Asha Name');
    expect((await w.platform.people.member(w.as(w.ngoB), added.userId)).displayName).toBe('Bodhi Name');
  });
});
