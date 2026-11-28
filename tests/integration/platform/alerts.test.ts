import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '@onengo/server/http/server.js';
import { ALERT, checkMemory, DEFAULT_MEMORY_ALERT_MB } from '@onengo/kernel/observability';
import { enqueueEvent } from '../../../packages/platform/src/infrastructure/postgres/stores/audit-store.js';
import { notFound } from '@onengo/kernel/errors';
import { MemoryLogger } from '@onengo/kernel/observability';
import { MAX_ATTEMPTS } from '../../../packages/platform/src/infrastructure/outbox/outbox-dispatcher.js';
import { createWorld, type TestWorld } from '../../support/platform/helpers.js';

let w: TestWorld;
const logger = new MemoryLogger();
let mark = 0;
const alerts = () => logger.entries.slice(mark).filter((e) => e.fields.alert !== undefined);
const MB = 1024 * 1024;

beforeAll(async () => {
  // Any real process is above 1 MB, so every tick reports high memory.
  w = await createWorld({ donations: false, autoRunJobs: false, logger, memoryAlertMb: 1 });
  w.platform.jobs.register('test.broken', {
    label: 'Broken',
    async run() {
      throw new Error('the file could not be read');
    },
  });
});
afterAll(() => w.close());
beforeEach(async () => {
  await w.platform.dispatcher.runOnce();
  await w.platform.jobs.runOnce();
  mark = logger.entries.length;
});

describe('alert events', () => {
  it('an outbox event that fails its last attempt raises outbox.failed_permanently once', async () => {
    w.platform.dispatcher.on('test.alwaysFails', 'down', async () => {
      throw new Error('the gateway is down');
    });
    await w.platform.db.withTenant(w.ngoA, (tx) => enqueueEvent(tx, 'test.alwaysFails', {}));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await w.platform.dispatcher.runOnce();
      await w.platform.db.asSystem((tx) => tx.query(`update outbox_event set available_at = now() where status = 'pending'`));
    }
    expect(logger.entries.slice(mark).filter((e) => e.message === 'Background event failed; will retry')).toHaveLength(MAX_ATTEMPTS - 1);
    expect(alerts()).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        message: 'Background event failed permanently',
        fields: expect.objectContaining({ alert: ALERT.outboxFailedPermanently, eventType: 'test.alwaysFails', tenantId: w.ngoA, attempt: MAX_ATTEMPTS }),
      }),
    ]);
  });

  it('a failed job raises job.failed once', async () => {
    const job = await w.platform.jobs.create(w.as(w.ngoA), 'test.broken', {});
    await w.platform.jobs.runOnce();
    expect((await w.platform.jobs.get(w.as(w.ngoA), job.id)).status).toBe('failed');
    expect(alerts()).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        error: 'the file could not be read',
        fields: expect.objectContaining({ alert: ALERT.jobFailed, jobId: job.id, kind: 'test.broken', tenantId: w.ngoA }),
      }),
    ]);
  });

  it('an unhandled route error raises http.unhandled_error once; an expected error raises none', async () => {
    const app = buildServer(w.platform, { devAuth: true });
    app.get('/api/boom', async () => {
      throw new Error('unexpected');
    });
    app.get('/api/missing', async () => {
      throw notFound('Not here.');
    });
    expect((await app.inject({ method: 'GET', url: '/api/missing' })).statusCode).toBe(404);
    expect(alerts()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/boom' })).statusCode).toBe(500);
    expect(alerts()).toEqual([
      expect.objectContaining({ severity: 'ERROR', message: 'Unhandled error', fields: expect.objectContaining({ alert: ALERT.httpUnhandledError, path: '/api/boom' }) }),
    ]);
    await app.close();
  });

  it('a memory reading above the threshold raises memory.high once; one at or below raises none', () => {
    const local = new MemoryLogger();
    expect(checkMemory(local, DEFAULT_MEMORY_ALERT_MB, () => 300 * MB)).toEqual({ rssMb: 300, high: false });
    expect(local.entries).toEqual([]);
    expect(checkMemory(local, undefined, () => 350 * MB)).toEqual({ rssMb: 350, high: true });
    expect(local.entries).toEqual([
      { severity: 'WARNING', message: 'Memory use is high', fields: { alert: ALERT.memoryHigh, rssMb: 350, thresholdMb: 300 }, error: undefined },
    ]);
  });

  it('each tick checks memory against the configured threshold', async () => {
    await w.platform.tick();
    expect(alerts()).toEqual([
      expect.objectContaining({ severity: 'WARNING', fields: expect.objectContaining({ alert: ALERT.memoryHigh, thresholdMb: 1 }) }),
    ]);
  });
});