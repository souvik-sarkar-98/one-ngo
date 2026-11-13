import { describe, expect, it } from 'vitest';
import { fixtureFetch, fixtureOrigin, fixtureUrl, installFixtureHosts, installFixtureHostsIfConfigured, INTEGRATION_FIXTURE_ORIGIN } from '../src/fixture-hosts.js';

const FIXTURE = 'https://127.0.0.1:8095';

describe('fixture hosts', () => {
  it('always sends Cloud Storage, the metadata token and the breached-password range to the fixture', () => {
    expect(INTEGRATION_FIXTURE_ORIGIN).toBe(FIXTURE);
    const cases: [string, string][] = [
      ['https://storage.googleapis.com/upload/storage/v1/b/my-bucket/o?uploadType=media&name=files%2Fa', `${FIXTURE}/upload/storage/v1/b/my-bucket/o?uploadType=media&name=files%2Fa`],
      ['https://storage.googleapis.com/storage/v1/b/my-bucket/o/files%2Fa?alt=media', `${FIXTURE}/storage/v1/b/my-bucket/o/files%2Fa?alt=media`],
      ['https://STORAGE.googleapis.com./storage/v1/b/my-bucket/o/files%2Fa', `${FIXTURE}/storage/v1/b/my-bucket/o/files%2Fa`],
      ['http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', `${FIXTURE}/token`],
      ['http://metadata.google.internal/computeMetadata/v1/project/project-id', `${FIXTURE}/computeMetadata/v1/project/project-id`],
      ['https://api.pwnedpasswords.com/range/5BAA6', `${FIXTURE}/range/5BAA6`],
    ];
    for (const [from, to] of cases) {
      const rewritten = fixtureUrl(from);
      expect(rewritten, from).toBe(to);
      expect(rewritten.toLowerCase()).not.toMatch(/googleapis\.com|pwnedpasswords\.com|metadata\.google\.internal/);
    }
  });

  it('follows a loopback fixture origin and ignores any other one', () => {
    const previous = process.env.INTEGRATION_FIXTURE_ORIGIN;
    try {
      process.env.INTEGRATION_FIXTURE_ORIGIN = 'https://127.0.0.1:8096';
      expect(fixtureOrigin()).toBe('https://127.0.0.1:8096');
      expect(fixtureUrl('https://storage.googleapis.com/storage/v1/b/b/o/k')).toBe('https://127.0.0.1:8096/storage/v1/b/b/o/k');
      expect(fixtureUrl('https://api.pwnedpasswords.com/range/5BAA6')).toBe('https://127.0.0.1:8096/range/5BAA6');
      process.env.INTEGRATION_FIXTURE_ORIGIN = 'https://storage.googleapis.com';
      expect(fixtureOrigin()).toBe(FIXTURE);
      expect(fixtureUrl('https://api.pwnedpasswords.com/range/5BAA6')).toBe(`${FIXTURE}/range/5BAA6`);
    } finally {
      if (previous === undefined) delete process.env.INTEGRATION_FIXTURE_ORIGIN;
      else process.env.INTEGRATION_FIXTURE_ORIGIN = previous;
    }
  });

  it('leaves the payment gateways, Google sign-in and every other host alone', () => {
    for (const url of [
      'https://api.razorpay.com/v1/orders',
      'https://api.cashfree.com/pg/orders',
      'https://sandbox.cashfree.com/pg/orders',
      'https://accounts.google.com/.well-known/openid-configuration',
      'https://www.googleapis.com/oauth2/v3/certs',
      'https://bucket.storage.googleapis.com.example.org/x',
      'https://api.pwnedpasswords.com/breachedaccount/x',
      'https://haveibeenpwned.com/range/5BAA6',
      'https://127.0.0.1:8095/range/5BAA6',
      'http://localhost:8080/health',
      'not a url',
    ]) {
      expect(fixtureUrl(url), url).toBe(url);
    }
  });

  it('rewrites string, URL and Request inputs and passes other requests through unchanged', async () => {
    const seen: { input: unknown; init: RequestInit | undefined }[] = [];
    const base = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ input, init });
      return new Response('ok');
    }) as typeof fetch;
    const wrapped = fixtureFetch(base);

    await wrapped('https://api.pwnedpasswords.com/range/ABCDE', { headers: { 'Add-Padding': 'true' } });
    expect(seen.at(-1)).toEqual({ input: `${FIXTURE}/range/ABCDE`, init: { headers: { 'Add-Padding': 'true' } } });

    await wrapped(new URL('https://storage.googleapis.com/storage/v1/b/b/o/k?alt=media'));
    expect(seen.at(-1)!.input).toBe(`${FIXTURE}/storage/v1/b/b/o/k?alt=media`);

    await wrapped(new Request('https://storage.googleapis.com/storage/v1/b/b/o/k', { method: 'DELETE', headers: { authorization: 'Bearer t' } }));
    expect(seen.at(-1)!.input).toBe(`${FIXTURE}/storage/v1/b/b/o/k`);
    expect(seen.at(-1)!.init).toMatchObject({ method: 'DELETE' });
    expect(new Headers(seen.at(-1)!.init!.headers).get('authorization')).toBe('Bearer t');

    const razorpay = new URL('https://api.razorpay.com/v1/orders');
    await wrapped(razorpay, { method: 'POST' });
    expect(seen.at(-1)).toEqual({ input: razorpay, init: { method: 'POST' } });
    const cashfree = new Request('https://api.cashfree.com/pg/orders', { method: 'POST', body: '{}' });
    await wrapped(cashfree);
    expect(seen.at(-1)!.input).toBe(cashfree);
    await wrapped('https://example.org/');
    expect(seen.at(-1)!.input).toBe('https://example.org/');
  });

  it('installs on the process fetch', async () => {
    const calls: string[] = [];
    const target = { fetch: (async (input: string | URL | Request) => (calls.push(String(input)), new Response('ok'))) as typeof fetch };
    installFixtureHosts(target);
    await target.fetch('https://storage.googleapis.com/storage/v1/b/b/o/k');
    await target.fetch('https://api.razorpay.com/v1/orders');
    expect(calls).toEqual([`${FIXTURE}/storage/v1/b/b/o/k`, 'https://api.razorpay.com/v1/orders']);
  });

  it('installs only when a fixture origin is configured, so deployments keep the real hosts', async () => {
    const calls: string[] = [];
    const makeTarget = () => ({ fetch: (async (input: string | URL | Request) => (calls.push(String(input)), new Response('ok'))) as typeof fetch });

    const unconfigured = makeTarget();
    expect(installFixtureHostsIfConfigured({}, unconfigured)).toBe(false);
    expect(installFixtureHostsIfConfigured({ INTEGRATION_FIXTURE_ORIGIN: '  ' }, unconfigured)).toBe(false);
    await unconfigured.fetch('https://storage.googleapis.com/storage/v1/b/b/o/k');
    expect(calls).toEqual(['https://storage.googleapis.com/storage/v1/b/b/o/k']);

    calls.length = 0;
    const configured = makeTarget();
    expect(installFixtureHostsIfConfigured({ INTEGRATION_FIXTURE_ORIGIN: FIXTURE }, configured)).toBe(true);
    await configured.fetch('https://storage.googleapis.com/storage/v1/b/b/o/k');
    expect(calls).toEqual([`${FIXTURE}/storage/v1/b/b/o/k`]);
  });
});
