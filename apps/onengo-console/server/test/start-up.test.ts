import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OperatorProvider } from '../src/operators/provider.js';
import { assertConsoleSettings, iapAudience, REQUIRED_SETTINGS } from '../src/settings.js';

const complete = Object.fromEntries(REQUIRED_SETTINGS.map((name) => [name, 'set']));
const ISSUER = 'https://idp.example';
const config = { issuer: ISSUER, clientId: 'console', redirectUri: 'https://console.example/op/auth/callback', audience: 'console' };
const discovery = { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` };
const answering = (...bodies: (object | number)[]): typeof fetch => {
  let call = 0;
  return (async () => {
    const body = bodies[Math.min(call++, bodies.length - 1)]!;
    return typeof body === 'number' ? new Response('', { status: body }) : Response.json(body);
  }) as typeof fetch;
};

describe('console start-up settings', () => {
  it('requires the operator identity provider and names every missing setting at once', () => {
    expect(() => assertConsoleSettings(complete)).not.toThrow();
    expect(() => assertConsoleSettings({ ...complete, OPERATOR_OIDC_ISSUER: ' ', OPERATOR_OIDC_CLIENT_ID: '', OPERATOR_OIDC_AUDIENCE: undefined }))
      .toThrow('Set OPERATOR_OIDC_ISSUER, OPERATOR_OIDC_CLIENT_ID, OPERATOR_OIDC_AUDIENCE.');
    expect(() => assertConsoleSettings({})).toThrow(new RegExp(REQUIRED_SETTINGS.join(', ')));
  });

  it('refuses to start outside local mode without an IAP audience, and still starts locally without one', () => {
    expect(iapAudience({ OPERATOR_IAP_AUDIENCE: ' /projects/1/apps/p ' }, false)).toBe('/projects/1/apps/p');
    expect(() => iapAudience({}, false)).toThrow('Set OPERATOR_IAP_AUDIENCE.');
    expect(() => iapAudience({ OPERATOR_IAP_AUDIENCE: '  ' }, false)).toThrow('Set OPERATOR_IAP_AUDIENCE.');
    expect(iapAudience({}, true)).toBeUndefined();
    expect(() => iapAudience({ OPERATOR_IAP_AUDIENCE: '/projects/1/apps/p' }, true)).toThrow(/OPERATOR_LOCAL_WITHOUT_IAP/);
  });

  it('lists the IAP audience as a required console deploy setting', () => {
    const manifest = readFileSync(new URL('../app.yaml', import.meta.url), 'utf8');
    expect(manifest).toContain('OPERATOR_IAP_AUDIENCE: REPLACE_WITH_CONSOLE_IAP_AUDIENCE');
  });
});

describe('operator identity provider check', () => {
  it('accepts a matching discovery document', async () => {
    await expect(new OperatorProvider(config, answering(discovery)).check()).resolves.toBeUndefined();
  });

  it('refuses an unreachable provider, a different issuer and a document without endpoints', async () => {
    await expect(new OperatorProvider(config, answering(503)).check()).rejects.toThrow(/unavailable/);
    await expect(new OperatorProvider(config, answering({ ...discovery, issuer: 'https://other.example' })).check()).rejects.toThrow(/issuer mismatch/);
    await expect(new OperatorProvider(config, answering({ ...discovery, jwks_uri: '' })).check()).rejects.toThrow(/jwks_uri/);
  });

  it('tries the provider again after a failed read', async () => {
    const provider = new OperatorProvider(config, answering(503, discovery));
    await expect(provider.check()).rejects.toThrow();
    await expect(provider.check()).resolves.toBeUndefined();
  });
});
