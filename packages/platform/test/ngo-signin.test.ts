import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '@onengo/kernel/crypto';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

let w: TestWorld;
const password = 'long enough password';

beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

describe('NGO sign-in policy and session evidence', () => {
  it('refuses an assurance downgrade and accepts a local second factor', async () => {
    const userId = await w.platform.identity.addMember(w.as(w.ngoA), {
      email: 'assured@example.org',
      displayName: 'Assured',
      roles: [],
    });
    await w.platform.identity.setPassword(userId, password);
    const first = await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'assured@example.org', password });
    const ctx = await w.platform.identity.authenticate(first.accessToken);
    const { secret } = await w.platform.identity.beginTwoStep(ctx);
    await w.platform.identity.confirmTwoStep(ctx, totpCode(secret));
    await w.platform.identity.saveAuthPolicy(w.as(w.ngoA), {
      passwordEnabled: true,
      emailCodeEnabled: true,
      passkeyEnabled: false,
      minimumAssurance: 'aal2',
    });

    await expectCode(
      w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'assured@example.org', password }),
      'forbidden',
    );
    const pair = await w.platform.identity.loginWithPassword({
      tenantKey: 'asha',
      email: 'assured@example.org',
      password,
      totpCode: totpCode(secret),
    });
    expect(pair).toMatchObject({ method: 'password', assurance: 'aal2', amr: ['pwd', 'otp'] });

    const refreshed = await w.platform.identity.refresh(pair.refreshToken);
    expect(refreshed).toMatchObject({ method: 'password', assurance: 'aal2', amr: ['pwd', 'otp'] });
    expect(refreshed.authTime.toISOString()).toBe(pair.authTime.toISOString());

    await w.platform.identity.endSessionsByMethod(w.ngoA, userId, 'password');
    await expectCode(w.platform.identity.authenticate(refreshed.accessToken), 'forbidden');
  });

  it('requires two protected administrators before passwords are disabled', async () => {
    await w.platform.identity.saveAuthPolicy(w.as(w.ngoA), {
      passwordEnabled: true,
      emailCodeEnabled: true,
      passkeyEnabled: false,
      minimumAssurance: 'aal1',
    });
    await w.platform.identity.upsertRole(w.as(w.ngoA), { key: 'auth-admin', label: 'Auth admin', permissions: ['auth:configure'] });
    await w.platform.identity.addMember(w.as(w.ngoA), {
      email: 'admin-one@example.org',
      displayName: 'Admin one',
      roles: ['auth-admin'],
    });
    await expectCode(
      w.platform.identity.saveAuthPolicy(w.as(w.ngoA), {
        passwordEnabled: false,
        emailCodeEnabled: true,
        passkeyEnabled: false,
        minimumAssurance: 'aal1',
      }),
      'validation_failed',
    );
    await w.platform.identity.addMember(w.as(w.ngoA), {
      email: 'admin-two@example.org',
      displayName: 'Admin two',
      roles: ['auth-admin'],
    });
    await w.platform.identity.saveAuthPolicy(w.as(w.ngoA), {
      passwordEnabled: false,
      emailCodeEnabled: true,
      passkeyEnabled: false,
      minimumAssurance: 'aal1',
    });
    expect(await w.platform.identity.authPolicy(w.ngoA)).toMatchObject({ passwordEnabled: false });
  });
});
