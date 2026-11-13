import { describe, expect, it } from 'vitest';
import { installationOidcFromEnvironment } from '../src/composition/entry.js';

describe('installationOidcFromEnvironment', () => {
  it('offers no provider without a client id', () => {
    expect(installationOidcFromEnvironment({})).toEqual([]);
    expect(installationOidcFromEnvironment({ OIDC_ISSUER: 'https://idp.example', OIDC_CLIENT_SECRET: 's' })).toEqual([]);
  });

  it('defaults to Google', () => {
    expect(installationOidcFromEnvironment({ OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 'secret' })).toEqual([
      { id: 'google', label: 'Google', issuer: 'https://accounts.google.com', clientId: 'id', clientSecret: 'secret' },
    ]);
  });

  it('accepts any issuer with its own id and label', () => {
    const [provider] = installationOidcFromEnvironment({
      OIDC_ISSUER: 'https://tenant.auth0.com/',
      OIDC_CLIENT_ID: 'id',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ALLOWED_DOMAINS: ' Asha.org, ,example.org ',
    });
    expect(provider).toEqual({
      id: 'sso',
      label: 'Single sign-on',
      issuer: 'https://tenant.auth0.com/',
      clientId: 'id',
      clientSecret: 'secret',
      allowedDomains: ['asha.org', 'example.org'],
    });
    expect(installationOidcFromEnvironment({ OIDC_ISSUER: 'https://login.example', OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 's', OIDC_PROVIDER_ID: 'entra', OIDC_PROVIDER_LABEL: 'Microsoft' })[0])
      .toMatchObject({ id: 'entra', label: 'Microsoft' });
  });

  it('keeps reading the older GOOGLE_* settings as Google', () => {
    expect(installationOidcFromEnvironment({
      GOOGLE_ISSUER: 'http://127.0.0.1:8095',
      GOOGLE_CLIENT_ID: 'demo-google',
      GOOGLE_CLIENT_SECRET: 'demo-google-secret',
      GOOGLE_ALLOWED_DOMAINS: 'asha.org',
    })).toEqual([{ id: 'google', label: 'Google', issuer: 'http://127.0.0.1:8095', clientId: 'demo-google', clientSecret: 'demo-google-secret', allowedDomains: ['asha.org'] }]);
  });

  it('prefers OIDC_* over GOOGLE_*', () => {
    expect(installationOidcFromEnvironment({ OIDC_CLIENT_ID: 'new', GOOGLE_CLIENT_ID: 'old', GOOGLE_CLIENT_SECRET: 's' })[0]).toMatchObject({ clientId: 'new', clientSecret: 's' });
  });

  it('refuses a client id without a secret and a malformed provider id', () => {
    expect(() => installationOidcFromEnvironment({ OIDC_CLIENT_ID: 'id' })).toThrow('Set OIDC_CLIENT_SECRET.');
    expect(() => installationOidcFromEnvironment({ OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 's', OIDC_PROVIDER_ID: 'Bad Id' })).toThrow(/OIDC_PROVIDER_ID/);
  });
});
