import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/http/server.js';
import { clientAddressKey, proxyTrust, trustProxyFromEnv } from '../../src/http/client-address.js';
import { ORGANISATION_LOOKUP_FLOOR_MS } from '../../src/http/plugins/organisation.js';
import { MemoryRateLimiter, safeNextPath } from '@onengo/platform/testing';
import { safeNext } from '@onengo/web-kit';
import { createWorld, type TestWorld } from '../../../../../packages/platform/test/helpers.js';

/**
 * Probes for S4-4, S4-5, S4-17 and the row-level security inventory (docs/reports/s4-review-2026-10-26.md).
 * Each asserts the SAFE behaviour.
 */

const UNSAFE_NEXT = [
  '/\t/evil.example',
  '/\n/evil.example',
  '/\r/evil.example',
  '/\u0000/evil.example',
  '//evil.example',
  '/\\evil.example',
  '/\\/evil.example',
  'https://evil.example',
  'javascript:alert(1)',
  'evil.example',
  '/%09/evil.example',
  '/%0a/evil.example',
  '/%2F/evil.example',
  '/%2f%2fevil.example',
  '/%5Cevil.example',
  '/%252F/evil.example',
  '/.//evil.example',
  '/a/../..//evil.example',
  `/${'a'.repeat(2100)}`,
  '',
  null,
  undefined,
];
const SAFE_NEXT: [string, string][] = [
  ['/', '/'],
  ['/records/donation?id=4', '/records/donation?id=4'],
  ['/records/../inbox?tab=mine#top', '/inbox?tab=mine#top'],
  ['/records?q=100%25', '/records?q=100%25'],
  ['/people/a%20b', '/people/a%20b'],
];

describe('S4-5 the page after provider sign-in stays on this site', () => {
  it('S4-5: a next path with a tab or newline after the first slash is not sent to another host', () => {
    for (const next of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example']) {
      const target = new URL(safeNextPath(next), 'https://ngo.test/');
      expect(target.host, JSON.stringify(next)).toBe('ngo.test');
    }
  });

  it('S4-5 (control): plain protocol-relative and backslash forms are already refused', () => {
    for (const next of ['//evil.example', '/\\evil.example', 'https://evil.example']) expect(safeNextPath(next)).toBe('/');
  });

  it('S4-5: refuses control characters, backslashes, schemes and their encoded forms; keeps in-app paths', () => {
    for (const next of UNSAFE_NEXT) expect(safeNextPath(next), JSON.stringify(next)).toBe('/');
    for (const [next, want] of SAFE_NEXT) expect(safeNextPath(next), next).toBe(want);
  });

  it('S4-5: the web app applies exactly the same rule as the server', () => {
    for (const next of [...UNSAFE_NEXT, ...SAFE_NEXT.map(([n]) => n)]) {
      expect(safeNext(next), JSON.stringify(next)).toBe(safeNextPath(next));
    }
  });
});

describe('S4-4 the shared limiter cannot be emptied', () => {
  it('evicts no caller that is over its limit when the table fills', () => {
    const limiter = new MemoryRateLimiter(2, 60_000, 10);
    for (let i = 0; i < 3; i++) limiter.hit('attacker', 0);
    expect(limiter.hit('attacker', 1)).toBe(false);
    for (let i = 0; i < 500; i++) limiter.hit(`flood-${i}`, 2);
    expect(limiter.size).toBeLessThanOrEqual(10);
    expect(limiter.hit('attacker', 3)).toBe(false);
    expect(limiter.hit('attacker', 60_001)).toBe(true);
  });

  it('when every slot holds a blocked caller, new keys share one overflow window instead of going unlimited', () => {
    const limiter = new MemoryRateLimiter(1, 60_000, 4);
    for (let i = 0; i < 4; i++) {
      limiter.hit(`blocked-${i}`, 0);
      limiter.hit(`blocked-${i}`, 0);
    }
    expect(limiter.hit('new-1', 1)).toBe(true);
    expect(limiter.hit('new-2', 1)).toBe(false);
    expect(limiter.hit('blocked-0', 1)).toBe(false);
  });

  it('drops expired windows first and bounds key length', () => {
    const limiter = new MemoryRateLimiter(1, 1000, 3);
    for (const k of ['a', 'b', 'c']) limiter.hit(k, 0);
    expect(limiter.hit('d', 1000)).toBe(true);
    expect(limiter.size).toBe(1);
    expect(limiter.hit('x'.repeat(5000), 1001)).toBe(true);
    expect(limiter.hit(`${'x'.repeat(5000)}y`, 1001)).toBe(false);
  });

  it('keys IPv6 callers by their /64 and IPv4-mapped addresses as IPv4', () => {
    expect(clientAddressKey('2001:db8:1:2:aaaa::1')).toBe(clientAddressKey('2001:db8:1:2:ffff:1:2:3'));
    expect(clientAddressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientAddressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientAddressKey('2001:db8:1:3::1')).not.toBe(clientAddressKey('2001:db8:1:2::1'));
    expect(clientAddressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddressKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('reads the trusted-proxy setting from the environment, never trusting every hop', () => {
    expect(trustProxyFromEnv({})).toBeUndefined();
    expect(trustProxyFromEnv({ GAE_SERVICE: 'default' })).toBe(1);
    expect(trustProxyFromEnv({ GAE_SERVICE: 'default', TRUST_PROXY: '2' })).toBe(2);
    expect(trustProxyFromEnv({ TRUST_PROXY: '35.191.0.0/16, 130.211.0.0/22' })).toEqual(['35.191.0.0/16', '130.211.0.0/22']);
    for (const bad of ['true', '*', '99', 'loopback; rm']) expect(() => trustProxyFromEnv({ TRUST_PROXY: bad }), bad).toThrow();
    expect(proxyTrust(undefined)).toBe(false);
    expect(proxyTrust(0)).toBe(false);
    expect(() => proxyTrust(1.5)).toThrow();
  });
});

describe('server-level probes', () => {
  let w: TestWorld;
  let app: FastifyInstance;
  beforeAll(async () => {
    w = await createWorld();
    app = buildServer(w.platform, { trustProxy: 1, rateLimits: { auth: 5, api: 1000, webhooks: 1000 } });
  });
  afterAll(async () => {
    await app.close();
    await w.close();
  });

  it('S4-4: behind the proxy, a caller cannot escape the sign-in rate limit by sending its own X-Forwarded-For', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/providers?tenant=asha',
        remoteAddress: '203.0.113.7',
        headers: { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.7` },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toContain(429);
  });

  it('S4-4: behind the proxy, the address the front end appended still separates real clients', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/providers?tenant=asha',
      remoteAddress: '169.254.1.1',
      headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.200' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('S4-4: without a trusted proxy, X-Forwarded-For is ignored entirely', async () => {
    const direct = buildServer(w.platform, { rateLimits: { auth: 2 } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await direct.inject({ method: 'GET', url: '/api/auth/providers?tenant=asha', remoteAddress: '203.0.113.8', headers: { 'x-forwarded-for': `198.51.100.${i}` } })).statusCode);
      }
      expect(statuses).toEqual([200, 200, 429, 429]);
    } finally {
      await direct.close();
    }
  });

  it('DEF-32: moving through the app spends the API budget, not the sign-in one', async () => {
    const tight = buildServer(w.platform, { rateLimits: { auth: 2, api: 1000 } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 15; i++) {
        for (const url of ['/api/auth/refresh', '/api/auth/organisations/asha/manifest.webmanifest']) {
          const method = url.endsWith('refresh') ? 'POST' : 'GET';
          statuses.push((await tight.inject({ method, url, remoteAddress: '203.0.113.60' })).statusCode);
        }
      }
      expect(statuses).not.toContain(429);
      const credentials = [];
      for (let i = 0; i < 4; i++) {
        credentials.push((await tight.inject({ method: 'GET', url: '/api/auth/providers?tenant=asha', remoteAddress: '203.0.113.60' })).statusCode);
      }
      expect(credentials).toEqual([200, 200, 429, 429]);
    } finally {
      await tight.close();
    }
  });

  it('S4-5: the provider start keeps only a safe next path', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/auth/oidc/google/start?tenant=asha&next=${encodeURIComponent('/\t/evil.example')}`, remoteAddress: '203.0.113.30' });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).not.toContain('evil.example');
  });

  it('S4-17: organisation lookups have their own tighter limit, known or unknown', async () => {
    const limited = buildServer(w.platform, { organisationLookupLimit: 3, rateLimits: { auth: 1000 } });
    try {
      const codes: number[] = [];
      for (const code of ['asha', 'nobody-1', 'nobody-2', 'asha', 'nobody-3']) {
        codes.push((await limited.inject({ method: 'GET', url: `/api/auth/organisations/${code}`, remoteAddress: '203.0.113.40' })).statusCode);
      }
      expect(codes).toEqual([200, 404, 404, 429, 429]);
      const other = await limited.inject({ method: 'GET', url: '/api/auth/organisations/asha', remoteAddress: '203.0.113.41' });
      expect(other.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('S4-17: found and unknown organisation codes both take at least the fixed floor to answer', async () => {
    for (const code of ['asha', 'nobody-here', 'asha/logo', 'nobody-here/logo']) {
      const started = performance.now();
      const res = await app.inject({ method: 'GET', url: `/api/auth/organisations/${code}`, remoteAddress: '203.0.113.50' });
      expect(performance.now() - started, code).toBeGreaterThanOrEqual(ORGANISATION_LOOKUP_FLOOR_MS - 5);
      expect([200, 404], code).toContain(res.statusCode);
    }
  });

  it('S4-17: sign-out and refresh refuse other sites when cross-site sign-in is enabled', async () => {
    const cors = buildServer(w.platform, { corsOrigins: ['https://app.example'], rateLimits: { auth: 1000 } });
    try {
      const post = (path: string, headers: Record<string, string>) =>
        cors.inject({ method: 'POST', url: path, headers: { host: 'ngo.test', cookie: 'ngo_rt=not-a-token', ...headers } });
      for (const path of ['/api/auth/logout', '/api/auth/refresh']) {
        for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
          const res = await post(path, headers);
          expect([res.statusCode, res.json().message], `${path} ${JSON.stringify(headers)}`).toEqual([403, 'This request must come from this site.']);
          expect(res.headers['set-cookie'], path).toBeUndefined();
        }
      }
      expect((await post('/api/auth/logout', { origin: 'https://app.example' })).statusCode).toBe(204);
      expect((await post('/api/auth/logout', { origin: 'https://ngo.test', 'sec-fetch-site': 'same-origin' })).statusCode).toBe(204);
      expect((await post('/api/auth/logout', {})).statusCode).toBe(204);
    } finally {
      await cors.close();
    }
  });

  it('RLS inventory: every table holding organisation data that the runtime role can touch has row-level security', async () => {
    const rows = await w.platform.db.asSystem((tx) =>
      tx.query<{ relname: string }>(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = current_schema() and c.relkind = 'r' and not c.relrowsecurity
           and (exists (select 1 from information_schema.role_table_grants g where g.table_schema = n.nspname and g.table_name = c.relname and g.grantee = 'app_runtime')
             or exists (select 1 from information_schema.column_privileges g where g.table_schema = n.nspname and g.table_name = c.relname and g.grantee = 'app_runtime'))`),
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('RLS inventory: the runtime role cannot bypass row-level security and every owner function pins its search path', async () => {
    const [role] = await w.platform.db.asSystem((tx) => tx.query<{ rolbypassrls: boolean; rolsuper: boolean }>(`select rolbypassrls, rolsuper from pg_roles where rolname = 'app_runtime'`));
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    const definers = await w.platform.db.asSystem((tx) =>
      tx.query<{ proname: string; pinned: boolean }>(`
        select p.proname, exists (select 1 from unnest(coalesce(p.proconfig, '{}')) s where s like 'search_path=%') as pinned
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = current_schema() and p.prosecdef`),
    );
    expect(definers.length).toBeGreaterThan(0);
    for (const d of definers) expect(d.pinned, d.proname).toBe(true);
  });
});
