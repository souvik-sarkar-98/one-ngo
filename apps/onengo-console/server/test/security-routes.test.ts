import { describe, expect, it, vi } from 'vitest';
import { buildOperatorServer } from '../src/http/server.js';
import { OperatorProvider } from '../src/operators/provider.js';
import { SESSION_COOKIE, SecretBox, canonicalTarget } from '../src/operators/security.js';

describe('operator security boundary', () => {
  it('requires provider-proven recent MFA and configured assurance', () => {
    const provider = new OperatorProvider({
      issuer: 'https://id.example/', clientId: 'operator', redirectUri: 'https://op.example/op/auth/callback',
      audience: 'operator-api', mfaAcr: 'urn:mfa',
    });
    const now = 1_800_000_000;
    expect(() => provider.requireFreshMfa({ issuer: 'https://id.example/', subject: 'x', emailVerified: true, authTime: now, amr: ['pwd'], acr: 'urn:mfa' }, now)).toThrow(/multi-factor/i);
    expect(() => provider.requireFreshMfa({ issuer: 'https://id.example/', subject: 'x', emailVerified: true, authTime: now - 301, amr: ['mfa'], acr: 'urn:mfa' }, now)).toThrow(/fresh/i);
    expect(() => provider.requireFreshMfa({ issuer: 'https://id.example/', subject: 'x', emailVerified: true, authTime: now, amr: ['mfa'], acr: 'wrong' }, now)).toThrow(/assurance/i);
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
