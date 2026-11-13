import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '@onengo/kernel/crypto';
import type { TenantContext } from '../../src/infrastructure/postgres/db.js';
import { createWorld, expectCode, type TestWorld } from '../helpers.js';

/**
 * Probes for the S4 security review (docs/reports/s4-review-2026-10-26.md).
 * Each test asserts the SAFE behaviour; `it.fails` marks a finding the current code still has.
 */
let w: TestWorld;
const password = 'a long enough password';

async function member(tenantId: string, email: string, roles: string[] = []): Promise<string> {
  const id = await w.platform.identity.addMember(w.as(tenantId), { email, displayName: email.split('@')[0]!, roles });
  await w.platform.identity.setPassword(id, password);
  return id;
}

const login = (email: string, tenant = 'asha', totp?: string) =>
  w.platform.identity.loginWithPassword({ tenantKey: tenant, email, password, ...(totp ? { totpCode: totp } : {}) });

beforeAll(async () => {
  w = await createWorld();
  for (const t of [w.ngoA, w.ngoB]) {
    await w.platform.identity.upsertRole(w.as(t), { key: 'admin', label: 'Administrator', permissions: ['*'] });
  }
});
afterAll(() => w.close());

describe('S4-3 two-step setup cannot be restarted by a bare session', () => {
  it('S4-3: restarting two-step setup with only an access token keeps the enrolled authenticator required', async () => {
    await member(w.ngoA, 's43@example.org');
    const first = await login('s43@example.org');
    const ctx = await w.platform.identity.authenticate(first.accessToken);
    const { secret } = await w.platform.identity.beginTwoStep(ctx);
    await w.platform.identity.confirmTwoStep(ctx, totpCode(secret));
    await expectCode(login('s43@example.org'), 'forbidden');

    // A stolen access token (or script running in the page) tries to restart setup without the password or a code.
    await expectCode(w.platform.identity.beginTwoStep(ctx), 'validation_failed');

    // Safe: password alone still does not sign in; vulnerable: two-step is now off for every organisation.
    await expectCode(login('s43@example.org'), 'forbidden');
  });
});

describe('S4-6 signing out ends the access token too', () => {
  it('S4-6: an access token stops working once its session is signed out', async () => {
    await member(w.ngoA, 's46@example.org');
    const pair = await login('s46@example.org');
    await w.platform.identity.authenticate(pair.accessToken);
    await w.platform.identity.logout(pair.refreshToken);
    await expectCode(w.platform.identity.authenticate(pair.accessToken), 'forbidden');
  });
});

describe('S4-7 people and API-key managers cannot grant more than they hold', () => {
  it('S4-7a: a member with only members:manage cannot give themselves the administrator role', async () => {
    await w.platform.identity.upsertRole(w.as(w.ngoA), { key: 'people-desk', label: 'People desk', permissions: ['members:manage'] });
    const id = await member(w.ngoA, 's47a@example.org', ['people-desk']);
    const ctx: TenantContext = { tenantId: w.ngoA, actor: { id, roles: ['people-desk'], permissions: ['members:manage'] } };
    await expectCode(w.platform.roles.setMemberRoles(ctx, id, { roles: ['people-desk', 'admin'] }), 'forbidden');
  });

  it('S4-7b: a member with only admin:api-keys cannot mint a key for the administrator role', async () => {
    const ctx: TenantContext = { tenantId: w.ngoA, actor: { id: 'keys-desk', roles: ['keys'], permissions: ['admin:api-keys'] } };
    await expectCode(w.platform.apiKeys.create(ctx, { name: 'escalate', role: 'admin' }), 'forbidden');
  });
});

describe('S4-10 one organisation cannot learn about accounts of another', () => {
  it("S4-10: adding an existing account's email does not reveal the name it has in another organisation", async () => {
    await w.platform.identity.addMember(w.as(w.ngoB), { email: 's410@example.org', displayName: 'Bodhi Secret Name', roles: [] });
    const { userId } = await w.platform.people.add(w.as(w.ngoA), { email: 's410@example.org', displayName: 'Typed by Asha', roles: [] });
    const seen = await w.platform.people.member(w.as(w.ngoA), userId);
    expect(seen.displayName).not.toBe('Bodhi Secret Name');
  });
});

describe('S4-11 a two-step code works once', () => {
  it('S4-11: the same authenticator code cannot sign in twice', async () => {
    await member(w.ngoA, 's411@example.org');
    const pair = await login('s411@example.org');
    const ctx = await w.platform.identity.authenticate(pair.accessToken);
    const { secret } = await w.platform.identity.beginTwoStep(ctx);
    await w.platform.identity.confirmTwoStep(ctx, totpCode(secret));
    const code = totpCode(secret);
    await login('s411@example.org', 'asha', code);
    await expectCode(login('s411@example.org', 'asha', code), 'forbidden');
  });
});
