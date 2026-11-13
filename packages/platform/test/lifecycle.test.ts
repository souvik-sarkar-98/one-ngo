import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { shutdown } from '@onengo/server/http/lifecycle.js';
import { buildServer } from '@onengo/server/http/server.js';
import { ACCESS_CHECK_MS } from '../src/application/identity/identity-service.js';
import { enqueueEvent } from '../src/infrastructure/postgres/stores/audit-store.js';
import { typed } from '../src/infrastructure/postgres/kysely.js';
import { MemoryLogger } from '@onengo/kernel/observability';
import { PgDatabase } from '../src/infrastructure/postgres/pg-database.js';
import { databaseReady } from '../src/infrastructure/postgres/readiness.js';
import { LocalFileStore } from '@onengo/kernel/files';
import { createPlatform, type Platform } from '../src/platform.js';
import { createWorld, expectCode, type TestWorld } from './helpers.js';

describe('readiness', () => {
  let w: TestWorld;
  beforeAll(async () => {
    w = await createWorld({ donations: false });
  });
  afterAll(() => w.close());

  it('answers ready while the database responds and 503 when it does not', async () => {
    const app = buildServer(w.platform);
    try {
      const ok = await app.inject({ method: 'GET', url: '/ready' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ status: 'ready' });

      const down = vi.spyOn(w.platform.db, 'asSystem').mockRejectedValue(new Error('connect ECONNREFUSED'));
      try {
        const res = await app.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ status: 'unavailable' });
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      } finally {
        down.mockRestore();
      }
    } finally {
      await app.close();
    }
  });

  it('is not ready when the database server cannot be reached', async () => {
    const stopped = new PgDatabase({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', maxConnections: 1 });
    try {
      expect(await databaseReady(stopped, 1_000)).toBe(false);
    } finally {
      await stopped.close();
    }
  });

  it('gives up within the timeout when the database hangs', async () => {
    const hang = vi.spyOn(w.platform.db, 'asSystem').mockReturnValue(new Promise(() => undefined));
    try {
      const started = Date.now();
      expect(await databaseReady(w.platform.db, 200)).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      hang.mockRestore();
    }
  });
});

describe('graceful shutdown', () => {
  it('finishes the in-flight request and the running outbox run, then closes the pool', async () => {
    const w = await createWorld({ donations: false });
    let shutDown = false;
    try {
      const app = buildServer(w.platform);
      let requestStarted!: () => void;
      const inFlight = new Promise<void>((resolve) => (requestStarted = resolve));
      app.get('/slow-test-route', async () => {
        requestStarted();
        await delay(400);
        return { finished: true };
      });
      let handled = false;
      w.platform.dispatcher.on('test.slow', 'slow', async () => {
        await delay(400);
        handled = true;
      });
      await w.platform.db.withTenant(w.ngoA, (tx) => enqueueEvent(tx, 'test.slow', {}));
      await app.listen({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

      const run = w.platform.dispatcher.runOnce();
      const response = fetch(`${base}/slow-test-route`);
      await inFlight;
      await shutdown(app, w.platform);
      shutDown = true;

      const res = await response;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ finished: true });
      expect((await run).processed).toBeGreaterThanOrEqual(1);
      expect(handled).toBe(true);
      await expect(fetch(`${base}/health`)).rejects.toThrow();
      await expect(w.platform.db.asSystem((tx) => typed(tx).selectFrom('outbox_event').select('id').execute())).rejects.toThrow();
    } finally {
      if (shutDown) vi.spyOn(w.platform.db, 'close').mockResolvedValue();
      await w.close();
    }
  });
});

describe('two instances on one database', () => {
  const tokenSecret = randomBytes(32).toString('hex');
  let w: TestWorld;
  let second: Platform;
  beforeAll(async () => {
    w = await createWorld({ tokenSecret });
    second = await createPlatform(w.platform.db, {
      tokenSecret,
      encryptionKey: randomBytes(32),
      logger: new MemoryLogger(),
      fileStore: new LocalFileStore(w.filesDir!),
    });
  });
  afterAll(() => w.close());

  it(`refuses a removed role on both instances within ${ACCESS_CHECK_MS} ms`, async () => {
    const userId = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'cashier@example.org', displayName: 'Cashier', roles: ['finance'] });
    await w.platform.identity.setPassword(userId, 'a long enough password');
    const { accessToken } = await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'cashier@example.org', password: 'a long enough password' });
    for (const instance of [w.platform, second]) expect((await instance.identity.authenticate(accessToken)).actor.roles).toEqual(['finance']);

    await w.platform.people.removeRoleMember(w.as(w.ngoA), 'finance', userId);
    const removedAt = Date.now();
    expect((await w.platform.identity.authenticate(accessToken)).actor.roles).toEqual([]);

    let seenAt = 0;
    while (Date.now() - removedAt < ACCESS_CHECK_MS + 2_000) {
      if (!(await second.identity.authenticate(accessToken)).actor.roles.includes('finance')) {
        seenAt = Date.now();
        break;
      }
      await delay(100);
    }
    expect(seenAt, 'the second instance never dropped the role').toBeGreaterThan(0);
    expect(seenAt - removedAt).toBeLessThanOrEqual(ACCESS_CHECK_MS + 500);
    for (const instance of [w.platform, second]) {
      const ctx = await instance.identity.authenticate(accessToken);
      await expectCode(instance.records.query(ctx, 'donation', {}), 'forbidden');
    }
  });

  it('refuses a suspended member on the other instance within the same time', async () => {
    const userId = await w.platform.identity.addMember(w.as(w.ngoA), { email: 'volunteer@example.org', displayName: 'Volunteer', roles: ['finance'] });
    await w.platform.identity.setPassword(userId, 'a long enough password');
    const { accessToken } = await w.platform.identity.loginWithPassword({ tenantKey: 'asha', email: 'volunteer@example.org', password: 'a long enough password' });
    await second.identity.authenticate(accessToken);

    await w.platform.people.suspend(w.as(w.ngoA), userId);
    await delay(ACCESS_CHECK_MS + 100);
    await expectCode(second.identity.authenticate(accessToken), 'forbidden');
  });
});
