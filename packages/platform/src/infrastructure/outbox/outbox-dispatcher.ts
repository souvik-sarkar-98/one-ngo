import { ALERT, silentLogger } from '@onengo/kernel/observability';
import type { SqlExecutor } from '../postgres/db.js';
import type { Logger } from '@onengo/kernel/ports';
import type { ClaimedEvent as Claimed, OutboxEvent, OutboxStore } from './ports/outbox-store.js';

export type { OutboxEvent } from './ports/outbox-store.js';

export interface HandlerRun {
  /**
   * Records the handler as finished inside the handler's own tenant
   * transaction, so its changes and the record commit or roll back together.
   * Without it the handler is recorded right after it returns.
   */
  complete(tx: SqlExecutor): Promise<void>;
}

export type OutboxHandler = (event: OutboxEvent, run: HandlerRun) => Promise<void>;

export interface DispatchResult {
  processed: number;
  failed: number;
  retried: number;
}

export const MAX_ATTEMPTS = 5;

/** Well inside the lease, so a slow handler keeps its event while the process is alive. */
const HEARTBEAT_MS = 60_000;

/**
 * Processes outbox events written in the same transaction as the change that
 * caused them. Runs on the scheduler tick and is nudged after requests, so no
 * broker or always-on worker is needed.
 *
 * Each handler is named and recorded on the event when it finishes; a retried
 * or re-claimed event runs only the handlers not yet recorded. A run owns an
 * event while `attempts` still holds the value its claim set.
 */
export class OutboxDispatcher {
  private readonly handlers = new Map<string, { name: string; handler: OutboxHandler }[]>();
  private running: Promise<DispatchResult> | null = null;
  private kickPending = false;
  private stopped = false;

  constructor(
    private readonly store: OutboxStore,
    private readonly logger: Logger = silentLogger,
  ) {}

  /** `name` identifies the handler in the event's record of finished handlers; keep it stable. */
  on(type: string, name: string, handler: OutboxHandler): void {
    const list = this.handlers.get(type) ?? [];
    if (list.some((h) => h.name === name)) throw new Error(`Outbox handler '${name}' is already registered for '${type}'.`);
    list.push({ name, handler });
    this.handlers.set(type, list);
  }

  /** Processes due events until none remain, `limit` is reached, or the time budget runs out. */
  async runOnce(options: { limit?: number; timeBudgetMs?: number } = {}): Promise<DispatchResult> {
    if (this.running) return this.running;
    this.running = this.drain(options.limit ?? 200, options.timeBudgetMs ?? 20_000).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * Stops background runs from starting and resolves when the current run ends.
   * Unfinished events keep their lease and are picked up by the next run anywhere.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => undefined);
  }

  /** Schedules a background run after the current request; safe to call often. */
  kick(): void {
    if (this.kickPending || this.stopped) return;
    this.kickPending = true;
    setImmediate(() => {
      this.kickPending = false;
      if (this.stopped) return;
      this.runOnce({ limit: 50, timeBudgetMs: 5_000 }).catch((error) =>
        this.logger.log('ERROR', 'Background dispatch run failed', {}, error),
      );
    });
  }

  private async drain(limit: number, budgetMs: number): Promise<DispatchResult> {
    const started = Date.now();
    const result: DispatchResult = { processed: 0, failed: 0, retried: 0 };
    while (!this.stopped && result.processed + result.failed + result.retried < limit && Date.now() - started < budgetMs) {
      const batch = await this.claim(Math.min(20, limit));
      if (!batch.length) break;
      for (const event of batch) {
        try {
          if (!(await this.handle(event))) continue;
          await this.store.markDone(event.id, event.attempts);
          result.processed++;
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
          const final = event.attempts >= MAX_ATTEMPTS;
          await this.store.markFailed(event.id, event.attempts, final, message);
          this.logger.log(
            final ? 'ERROR' : 'WARNING',
            final ? 'Background event failed permanently' : 'Background event failed; will retry',
            {
              ...(final ? { alert: ALERT.outboxFailedPermanently } : {}),
              eventId: event.id,
              eventType: event.type,
              tenantId: event.tenantId,
              attempt: event.attempts,
            },
            error,
          );
          if (final) result.failed++;
          else result.retried++;
        }
      }
    }
    return result;
  }

  /** Runs the handlers not yet recorded for the event; false when another run claimed it meanwhile. */
  private async handle(event: Claimed): Promise<boolean> {
    const { doneHandlers, ...visible } = event;
    let ranOne = false;
    for (const { name, handler } of this.handlers.get(event.type) ?? []) {
      if (doneHandlers.includes(name)) continue;
      if (ranOne && !(await this.renew(event))) {
        this.logger.log('NOTICE', 'Background event was claimed by another run; leaving it to that run', {
          eventId: event.id,
          eventType: event.type,
          tenantId: event.tenantId,
        });
        return false;
      }
      const heartbeat = setInterval(() => {
        this.renew(event).catch((error) => this.logger.log('WARNING', 'Could not extend a background event lease', { eventId: event.id }, error));
      }, HEARTBEAT_MS);
      heartbeat.unref();
      try {
        await handler(visible, { complete: (tx) => this.store.recordDone(tx, event.id, name) });
      } finally {
        clearInterval(heartbeat);
      }
      await this.store.recordDoneNow(event.id, name);
      ranOne = true;
    }
    return true;
  }

  /** Extends the lease while this run still owns the event. */
  private renew(event: Claimed): Promise<boolean> {
    return this.store.renew(event.id, event.attempts);
  }

  private claim(n: number): Promise<Claimed[]> {
    return this.store.claim(n);
  }
}
