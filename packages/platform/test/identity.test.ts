import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '@onengo/kernel/crypto';
import { admin, createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
let priya: string;
beforeAll(async () => {
  w = await createWorld();
  priya = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'Priya@Example.org', displayName: 'Priya', roles: ['finance'] });
  await w.platform.identity.setPassword(priya, 'a long enough password');
});
afterAll(() => w.close());

const login = (email = 'priya@example.org', password = 'a long enough password', tenant = 'asha', extra = {}) =>
  w.platform.identity.loginWithPassword({ tenantKey: tenant, email, password, ...extra });

describe('sign-in', () => {
  it('signs in with a password and resolves the NGO context with role permissions', async () => {
    const pair = await login('PRIYA@example.org');
    const ctx = await w.platform.identity.authenticate(pair.accessToken);
    expect(ctx.tenantId).toBe(w.ngoA);
    expect(ctx.actor.roles).toEqual(['finance']);
    expect(ctx.actor.permissions).toContain('record:donation:*');

    const { record } = await w.platform.records.create(ctx, 'donation', { donorName: 'Signed in', amount: 10 });
    expect(record.status).toBe('raised');
  });

  it('does not let a member of one NGO sign in to another', async () => {
    await expectCode(login(undefined, undefined, 'bodhi'), 'forbidden');
  });

  it('rejects short passwords', async () => {
    await expectCode(w.platform.identity.setPassword(priya, 'short'), 'validation_failed');
  });

  it('rotates refresh tokens and ends the session when an old one is reused', async () => {
    const first = await login();
    const second = await w.platform.identity.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expectCode(w.platform.identity.refresh(first.refreshToken), 'forbidden');
    await expectCode(w.platform.identity.refresh(second.refreshToken), 'forbidden');
  });

  it('logs out the whole session', async () => {
    const pair = await login();
    await w.platform.identity.logout(pair.refreshToken);
    await expectCode(w.platform.identity.refresh(pair.refreshToken), 'forbidden');
  });

  it('signs in with an emailed one-time code, without revealing unknown addresses', async () => {
    w.mail.sent.length = 0;
    await w.platform.identity.requestEmailCode({ tenantKey: 'asha', email: 'nobody@example.org' });
    expect(w.mail.sent).toHaveLength(0);
    await w.platform.identity.requestEmailCode({ tenantKey: 'asha', email: 'priya@example.org' });
    const code = /(\d{6})/.exec(w.mail.sent[0]!.text)![1]!;
    await expectCode(
      w.platform.identity.loginWithEmailCode({ tenantKey: 'asha', email: 'priya@example.org', code: code === '000000' ? '111111' : '000000' }),
      'forbidden',
    );
    const pair = await w.platform.identity.loginWithEmailCode({ tenantKey: 'asha', email: 'priya@example.org', code });
    expect(pair.userId).toBe(priya);
    await expectCode(w.platform.identity.loginWithEmailCode({ tenantKey: 'asha', email: 'priya@example.org', code }), 'forbidden');
  });

  it('locks an account after repeated failures', async () => {
    const victim = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'lock@example.org', displayName: 'Lock', roles: [] });
    await w.platform.identity.setPassword(victim, 'the right password!');
    for (let i = 0; i < 5; i++) await expectCode(login('lock@example.org', 'wrong password'), 'forbidden');
    const err = await expectCode(login('lock@example.org', 'the right password!'), 'forbidden');
    expect(err.message).toMatch(/Too many attempts/);
  });

  it('requires two-step codes for roles that demand it', async () => {
    await w.platform.identity.upsertRole(w.as(w.ngoA), { key: 'treasurer', label: 'Treasurer', permissions: ['*'], requireTwoStep: true });
    const t = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'treasurer@example.org', displayName: 'T', roles: [] });
    await w.platform.identity.setPassword(t, 'counting the coins');
    const before = await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'treasurer@example.org', password: 'counting the coins' });
    const ctx = await w.platform.identity.authenticate(before.accessToken);
    const { secret } = await w.platform.identity.beginTwoStep(ctx);
    await expectCode(w.platform.identity.confirmTwoStep(ctx, '000000'), 'validation_failed');
    await w.platform.identity.confirmTwoStep(ctx, totpCode(secret));

    await w.platform.people.addRoleMembers(w.as(w.ngoA), 'treasurer', { userIds: [t] });
    const needCode = await expectCode(
      w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'treasurer@example.org', password: 'counting the coins' }),
      'forbidden',
    );
    expect(needCode.name).toBe('TwoStepRequired');
    const pair = await w.platform.identity.loginWithPassword({
      tenantKey: 'asha',
      email: 'treasurer@example.org',
      password: 'counting the coins',
      totpCode: totpCode(secret),
    });
    expect(pair.userId).toBe(t);
  });

  it('removes access immediately when a member is suspended', async () => {
    const m = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'leaver@example.org', displayName: 'Leaver', roles: ['viewer'] });
    await w.platform.identity.setPassword(m, 'last day at work');
    const pair = await login('leaver@example.org', 'last day at work');
    await w.platform.people.suspend(w.as(w.ngoA, admin), m);
    await expectCode(w.platform.identity.refresh(pair.refreshToken), 'forbidden');
    await expectCode(login('leaver@example.org', 'last day at work'), 'forbidden');
  });

  it('requires permission to manage members and roles', async () => {
    const ctx = await w.platform.identity.authenticate((await login()).accessToken);
    await expectCode(w.platform.identity.addMember(ctx, { email: 'x@example.org', displayName: 'X', roles: [] }), 'forbidden');
    await expectCode(w.platform.identity.upsertRole(ctx, { key: 'boss', label: 'Boss', permissions: ['*'] }), 'forbidden');
  });
});
