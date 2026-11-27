import { describe, expect, it, vi } from 'vitest';
import { buildOperatorServer } from '../../../apps/onengo-console/server/src/http/server.js';
import { OperatorProvider } from '../../../apps/onengo-console/server/src/operators/provider.js';
import { SESSION_COOKIE, SecretBox, canonicalTarget } from '../../../apps/onengo-console/server/src/operators/security.js';

describe('operator security boundary', () => {
  it('requires a sign-in in the last five minutes for a step-up, without MFA', () => {
    const provider = new OperatorProvider({
      issuer: 'https://id.example/', clientId: 'operator', redirectUri: 'https://op.example/op/auth/callback',
      audience: 'operator-api',
    });
    const now = 1_800_000_000;
    expect(() => provider.requireRecentSignIn({ issuer: 'https://id.example/', subject: 'x', emailVerified: true, authTime: now, amr: ['pwd'] }, now)).not.toThrow();
    expect(() => provider.requireRecentSignIn({ issuer: 'https://id.example/', subject: 'x', emailVerified: true, authTime: now - 301, amr: ['pwd'] }, now)).toThrow(/fresh/i);
    expect(() => provider.requireRecentSignIn({ issuer: 'https://id.example/', subject: 'x', emailVerified: true, authTime: now + 120, amr: ['pwd'] }, now)).toThrow(/fresh/i);
  });

  it('encrypts provider material and canonicalises step-up targets', () => {
    const box = new SecretBox(Buffer.alloc(32, 7));
    const sealed = box.seal({ refresh_token: 'secret' });
    expect(sealed).not.toContain('secret');
    expect(box.open(sealed)).toEqual({ refresh_token: 'secret' });
    expect(canonicalTarget(' NGO-One ')).toBe('ngo-one');
    expect(SESSION_COOKIE).not.toBe('__Host-ngo_session');
  });

  it('exposes no listing or bulk organisation route and refuses member cookies', async () => {
    const store = {
      session: vi.fn().mockResolvedValue(undefined),
    };
    const app = buildOperatorServer({
      store: store as never,
      provider: { config: { issuer: 'https://id.example/' } } as never,
      control: {} as never,
    });
    const routes = app.printRoutes();
    expect(routes).not.toMatch(/list|bulk/);
    const response = await app.inject({
      method: 'GET', url: '/op/organisations/status?code=ngo-one',
      headers: { cookie: '__Host-ngo_session=member-token' },
    });
    expect(response.statusCode).toBe(403);
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
