import type { FastifyInstance } from 'fastify';
import type { ShutdownHost } from '@onengo/platform/main';

/** Longest wait for the running outbox run once requests have drained; App Engine allows about 30 s after SIGTERM. */
export const OUTBOX_DRAIN_MS = 10_000;

/**
 * Stops the instance without dropping work: refuses new connections and
 * waits for in-flight requests, lets the running outbox run finish (time-boxed;
 * events it has not reached stay pending for the next run), then closes the pool.
 */
export async function shutdown(app: FastifyInstance, platform: ShutdownHost, outboxDrainMs = OUTBOX_DRAIN_MS): Promise<void> {
  const log = platform.logger;
  log.log('INFO', 'Shutting down: refusing new requests');
  const closing = app.close();
  // A keep-alive connection that goes idle after its last in-flight response would otherwise hold close() open until its timeout.
  const sweep = setInterval(() => app.server.closeIdleConnections(), 100);
  try {
    await closing;
  } finally {
    clearInterval(sweep);
  }
  let timer: NodeJS.Timeout | undefined;
  const drained = await Promise.race([
    platform.dispatcher.stop().then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), outboxDrainMs);
    }),
  ]);
  clearTimeout(timer);
  if (!drained) log.log('WARNING', 'Outbox run did not finish before shutdown; its events will be picked up after their lease ends', { waitedMs: outboxDrainMs });
  await platform.db.close();
  log.log('INFO', 'Shut down');
}

/** Runs {@link shutdown} once on SIGTERM or SIGINT, then exits 0 (1 if shutting down failed). */
export function shutdownOnSignals(app: FastifyInstance, platform: ShutdownHost): void {
  let started = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (started) return;
    started = true;
    platform.logger.log('INFO', 'Signal received', { signal });
    shutdown(app, platform).then(
      () => process.exit(0),
      (error: unknown) => {
        platform.logger.log('CRITICAL', 'Shutdown failed', {}, error);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}
