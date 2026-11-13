import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectorAllowedHosts, fetchConnectorHttp, isPublicAddress, publicOnlyLookup } from '../../src/infrastructure/connectors/http.js';
import { runtimeRoleProblem } from '../../src/infrastructure/postgres/pg-database.js';
import { clerk, createWorld, type TestWorld } from '../helpers.js';

/** Probes for S4-9, S4-14 and S4-15 (docs/reports/s4-review-2026-10-26.md). */
let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

describe('S4-14 a tenant transaction cannot switch organisation', () => {
  it('refuses rows once app.tenant_id is changed with set_config', async () => {
    await w.platform.records.create(w.as(w.ngoA, clerk), 'donation', { donorName: 'Ravi', amount: 500 });
    await expect(
      w.platform.db.withTenant(w.ngoB, async (tx) => {
        await tx.query(`select set_config('app.tenant_id', $1, true)`, [w.ngoA]);
        return tx.query(`select count(*)::int as n from record`);
      }),
    ).rejects.toThrow(/not set by the server/);
  });

  it('refuses a runtime login that is a superuser, bypasses row security, owns the schema or is not app_runtime', () => {
    const ok = { login: 'rt', superuser: false, bypassRls: false, runtimeMember: true };
    expect(runtimeRoleProblem(ok, 'owner', false)).toBeNull();
    expect(runtimeRoleProblem({ ...ok, superuser: true }, 'owner', false)).toMatch(/superuser/);
    expect(runtimeRoleProblem({ ...ok, bypassRls: true }, 'owner', false)).toMatch(/bypasses/);
    expect(runtimeRoleProblem(ok, 'rt', false)).toMatch(/owner/);
    expect(runtimeRoleProblem(ok, 'owner', true)).toMatch(/owner/);
    expect(runtimeRoleProblem({ ...ok, runtimeMember: false }, 'owner', false)).toMatch(/app_runtime/);
  });
});

describe('S4-15 connectors only call public https addresses', () => {
  it('classifies addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::1', 'not-an-ip']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(a), a).toBe(true);
  });

  it('refuses a name that resolves to an internal address unless the host is allowed', async () => {
    const lookup = ((_host: string, _options: unknown, cb: (...args: unknown[]) => void) => cb(null, [{ address: '10.0.0.5', family: 4 }])) as never;
    const call = (allowed: string[]) =>
      new Promise((resolve) => publicOnlyLookup(new Set(allowed), lookup)('sms.internal', { all: true } as never, ((e: unknown, a: unknown) => resolve(e ?? a)) as never));
    expect(await call([])).toBeInstanceOf(Error);
    expect(await call(['sms.internal'])).toEqual([{ address: '10.0.0.5', family: 4 }]);
  });

  it('does not send to http, loopback or literal private addresses', async () => {
    const http = fetchConnectorHttp();
    const req = (url: string) => ({ url, method: 'POST' as const, headers: {}, body: '{}' });
    await expect(http(req('http://example.com/x'))).rejects.toThrow(/https/);
    await expect(http(req('https://127.0.0.1/x'))).rejects.toThrow(/not a public/);
    await expect(http(req('https://169.254.169.254/latest'))).rejects.toThrow(/not a public/);
    await expect(http(req('https://[::1]/x'))).rejects.toThrow(/not a public/);
    await expect(http(req('https://localhost/x'))).rejects.toThrow(/not a public/);
  });

  it('reads CONNECTOR_ALLOWED_HOSTS', () => {
    expect(connectorAllowedHosts(' SMS.Internal , ,b.test. ')).toEqual(['sms.internal', 'b.test']);
    expect(connectorAllowedHosts(undefined)).toEqual([]);
  });
});
