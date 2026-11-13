import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { totpCode, totpStep } from '@onengo/kernel/crypto';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
const password = 'a long enough password';

async function member(email: string): Promise<string> {
  const id = await w.platform.identity.addMember(w.as(w.ngoA), { email, displayName: email.split('@')[0]!, roles: [] });
  await w.platform.identity.setPassword(id, password);
  return id;
}

const login = (email: string, extra: { password?: string; totpCode?: string; ip?: string } = {}) =>
  w.platform.identity.loginWithPassword({ tenantKey: 'asha', email, password, ...extra });

/** Signs in and switches two-step on; returns the session and the secret. */
async function enrolled(email: string) {
  await member(email);
  const pair = await login(email);
  const ctx = await w.platform.identity.authenticate(pair.accessToken);
  const { secret } = await w.platform.identity.beginTwoStep(ctx);
  await w.platform.identity.confirmTwoStep(ctx, totpCode(secret));
  return { pair, ctx, secret };
}

const soon = (secret: string) => totpCode(secret, Date.now() + 30_000);

function lastCode(): string {
  return /(\d{6})/.exec(w.mail.sent.at(-1)!.text)![1]!;
}

function lastResetToken(): string {
  return new URL(/(https:\/\/ngo\.test\S+)/.exec(w.mail.sent.at(-1)!.text)![1]!).searchParams.get('token')!;
}

beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

describe('two-step codes', () => {
  it('finds the time step of a code within one period either side', () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const now = 1_790_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(totpStep(secret, totpCode(secret, now), now)).toBe(step);
    expect(totpStep(secret, totpCode(secret, now + 30_000), now)).toBe(step + 1);
    expect(totpStep(secret, totpCode(secret, now - 30_000), now)).toBe(step - 1);
    expect(totpStep(secret, totpCode(secret, now - 60_000), now)).toBeNull();
    expect(totpStep(secret, 'abcdef', now)).toBeNull();
  });

  it('refuses a code for a step at or before the last one used, on every sign-in path', async () => {
    const { secret } = await enrolled('replay@example.org');
    const later = soon(secret);
    await login('replay@example.org', { totpCode: later });
    // The current step is earlier than the one just used.
    await expectCode(login('replay@example.org', { totpCode: totpCode(secret) }), 'forbidden');

    w.mail.sent.length = 0;
    await w.platform.identity.requestEmailCode({ tenantKey: 'asha', email: 'replay@example.org' });
    await expectCode(
      w.platform.identity.loginWithEmailCode({ tenantKey: 'asha', email: 'replay@example.org', code: lastCode(), totpCode: later }),
      'forbidden',
    );
  });

  it('refuses the same code on a second two-step ticket', async () => {
    const { ctx, secret } = await enrolled('ticket@example.org');
    const ticket = async () => {
      const r = await w.platform.identity.signInVerifiedUser({ tenantId: w.ngoA, userId: ctx.actor.id, method: 'test' });
      if (r.kind !== 'twoStep') throw new Error('expected a two-step ticket');
      return r.ticket;
    };
    const code = soon(secret);
    await w.platform.identity.completeTwoStepTicket({ ticket: await ticket(), totpCode: code });
    await expectCode(w.platform.identity.completeTwoStepTicket({ ticket: await ticket(), totpCode: code }), 'forbidden');
  });
});

describe('setting up two-step again', () => {
  it('needs the password and a fresh code, and keeps the enrolled app until the new one is confirmed', async () => {
    const { ctx, secret } = await enrolled('again@example.org');
    await expectCode(w.platform.identity.beginTwoStep(ctx, { password }), 'validation_failed');
    await expectCode(w.platform.identity.beginTwoStep(ctx, { password: 'not the password', totpCode: totpCode(secret) }), 'validation_failed');
    await expectCode(w.platform.identity.beginTwoStep(ctx, { password, totpCode: '000000' }), 'validation_failed');

    const reauthCode = totpCode(secret);
    const next = await w.platform.identity.beginTwoStep(ctx, { password, totpCode: reauthCode });
    expect(next.secret).not.toBe(secret);
    // The code used to prove identity cannot be used again.
    await expectCode(w.platform.identity.beginTwoStep(ctx, { password, totpCode: reauthCode }), 'validation_failed');

    // Until confirmed, the old app is still required and still works.
    await expectCode(login('again@example.org'), 'forbidden');
    await login('again@example.org', { totpCode: soon(secret) });

    await expectCode(w.platform.identity.confirmTwoStep(ctx, totpCode(secret)), 'validation_failed');
    await w.platform.identity.confirmTwoStep(ctx, totpCode(next.secret));
    await expectCode(login('again@example.org', { totpCode: soon(secret) }), 'forbidden');
    await login('again@example.org', { totpCode: soon(next.secret) });
  });

  it('confirms only the newest setup', async () => {
    await member('newest@example.org');
    const ctx = await w.platform.identity.authenticate((await login('newest@example.org')).accessToken);
    const first = await w.platform.identity.beginTwoStep(ctx);
    const second = await w.platform.identity.beginTwoStep(ctx);
    await expectCode(w.platform.identity.confirmTwoStep(ctx, totpCode(first.secret)), 'validation_failed');
    await w.platform.identity.confirmTwoStep(ctx, totpCode(second.secret));
    expect((await w.platform.identity.profile(ctx)).twoStepEnabled).toBe(true);
  });

  it('counts wrong passwords towards the account lock', async () => {
    const { ctx, secret } = await enrolled('guess@example.org');
    for (let i = 0; i < 5; i++) {
      await expectCode(w.platform.identity.beginTwoStep(ctx, { password: `wrong guess ${i}`, totpCode: totpCode(secret) }), 'validation_failed');
    }
    const locked = await expectCode(w.platform.identity.beginTwoStep(ctx, { password, totpCode: totpCode(secret) }), 'validation_failed');
    expect(locked.message).toMatch(/Too many attempts/);
  });
});

describe('access tokens end with their session', () => {
  it('keeps working across refresh, and stops after reuse of an old refresh token', async () => {
    await member('session@example.org');
    const first = await login('session@example.org');
    const second = await w.platform.identity.refresh(first.refreshToken);
    await w.platform.identity.authenticate(first.accessToken);
    await w.platform.identity.authenticate(second.accessToken);
    await expectCode(w.platform.identity.refresh(first.refreshToken), 'forbidden');
    await expectCode(w.platform.identity.authenticate(second.accessToken), 'forbidden');
  });

  it('stops after a password reset, and only for that person', async () => {
    await member('reset.me@example.org');
    await member('bystander@example.org');
    const mine = await login('reset.me@example.org');
    const theirs = await login('bystander@example.org');
    await w.platform.identity.authenticate(mine.accessToken);
    w.mail.sent.length = 0;
    await w.platform.identity.requestPasswordReset({ tenantKey: 'asha', email: 'reset.me@example.org' });
    await w.platform.identity.completePasswordToken({ token: lastResetToken(), password: 'a brand new password' });
    await expectCode(w.platform.identity.authenticate(mine.accessToken), 'forbidden');
    await w.platform.identity.authenticate(theirs.accessToken);
  });

  it('stops when the member’s sessions are ended', async () => {
    const id = await member('ended@example.org');
    const pair = await login('ended@example.org');
    await w.platform.identity.authenticate(pair.accessToken);
    await w.platform.identity.endSessions(w.ngoA, id);
    const err = await expectCode(w.platform.identity.authenticate(pair.accessToken), 'forbidden');
    expect(err.message).toBe('Your session has ended. Sign in again.');
  });
});

describe('failed-password lockout (S4-13)', () => {
  it('still locks password sign-in for the account from every source', async () => {
    await member('brute@example.org');
    for (let i = 0; i < 5; i++) await expectCode(login('brute@example.org', { password: 'wrong password', ip: `198.51.100.${i}` }), 'forbidden');
    const err = await expectCode(login('brute@example.org', { ip: '203.0.113.9' }), 'forbidden');
    expect(err.message).toMatch(/Too many attempts/);
  });

  it('lets the holder sign in with an emailed code while password sign-in is locked, which clears the lock', async () => {
    await member('holder@example.org');
    for (let i = 0; i < 5; i++) await expectCode(login('holder@example.org', { password: 'stranger guessing', ip: '198.51.100.50' }), 'forbidden');
    await expectCode(login('holder@example.org', { ip: '203.0.113.10' }), 'forbidden');

    w.mail.sent.length = 0;
    await w.platform.identity.requestEmailCode({ tenantKey: 'asha', email: 'holder@example.org', ip: '203.0.113.10' });
    const pair = await w.platform.identity.loginWithEmailCode({ tenantKey: 'asha', email: 'holder@example.org', code: lastCode(), ip: '203.0.113.10' });
    expect(pair.accessToken).toBeTruthy();
    await login('holder@example.org', { ip: '203.0.113.10' });
  });

  it('clears the lock when the holder resets their password', async () => {
    await member('resetter@example.org');
    for (let i = 0; i < 5; i++) await expectCode(login('resetter@example.org', { password: 'stranger guessing' }), 'forbidden');
    w.mail.sent.length = 0;
    await w.platform.identity.requestPasswordReset({ tenantKey: 'asha', email: 'resetter@example.org' });
    await w.platform.identity.completePasswordToken({ token: lastResetToken(), password: 'my fresh password!' });
    await login('resetter@example.org', { password: 'my fresh password!' });
  });

  it('limits wrong emailed codes per account on their own counter', async () => {
    await member('codes@example.org');
    w.mail.sent.length = 0;
    await w.platform.identity.requestEmailCode({ tenantKey: 'asha', email: 'codes@example.org' });
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expectCode(w.platform.identity.loginWithEmailCode({ tenantKey: 'asha', email: 'codes@example.org', code: wrong, ip: `198.51.100.${60 + i}` }), 'forbidden');
    }
    const err = await expectCode(w.platform.identity.loginWithEmailCode({ tenantKey: 'asha', email: 'codes@example.org', code }), 'forbidden');
    expect(err.message).toMatch(/Too many attempts/);
    // Password sign-in is a separate counter.
    await login('codes@example.org');
  });
});

describe('POST /api/auth/two-step/begin', () => {
  let app: ReturnType<typeof buildServer>;
  beforeAll(() => {
    app = buildServer(w.platform, { devAuth: true, rateLimits: { auth: 1000 } });
  });
  afterAll(() => app.close());

  it('answers 422 without the password and a code while two-step is on', async () => {
    const { pair } = await enrolled('route@example.org');
    const bearer = { authorization: `Bearer ${pair.accessToken}` };
    const bare = await app.inject({ method: 'POST', url: '/api/auth/two-step/begin', headers: bearer, payload: {} });
    expect(bare.statusCode).toBe(422);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/two-step/begin', headers: bearer, payload: { password: 'nope', totpCode: '123456' } });
    expect(wrong.statusCode).toBe(422);
    const malformed = await app.inject({ method: 'POST', url: '/api/auth/two-step/begin', headers: bearer, payload: { password: 1 } });
    expect(malformed.statusCode).toBe(400);
  });
});
