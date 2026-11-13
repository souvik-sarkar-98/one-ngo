import { ALERT, silentLogger } from '@onengo/kernel/observability';
import type { Actor, SqlExecutor, TenantContext } from '../postgres/db.js';
import type { JobData, JobRow, JobStore } from './ports/job-store.js';
import {
  infrastructureConflict as conflict,
  infrastructureForbidden as forbidden,
  infrastructureNotFound as notFound,
  infrastructureValidationFailed as validationFailed,
} from '@onengo/kernel/errors';
import type { Logger } from '@onengo/kernel/ports';

import type { JobBatch, JobItemResult, JobKind, JobNotice, JobRun, JobStatus, JobView } from '../../runtime/records/ports/job-runner.js';

export type NotifyCreator = (tenantId: string, userId: string, notice: JobNotice) => Promise<void>;

/** Well inside the lease, so a slow batch keeps its job while the process is alive. */
const HEARTBEAT_MS = 30_000;
const iso = (d: Date | null) => (d === null ? null : d.toISOString());
function toView(r: JobRow): JobView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status as JobStatus,
    progress: r.progress,
    total: r.total,
    result: r.result,
    error: r.error,
    cancelRequested: r.cancel_requested,
    createdBy: r.created_by,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

/** The actor's access in the organisation now, never more than the actor started with; null when they may no longer act there (suspended, removed, revoked key). */
export type CurrentActor = (tenantId: string, actor: Actor) => Promise<Actor | null>;

export interface JobRunnerOptions {
  logger?: Logger;
  notify?: NotifyCreator;
  /** Re-checks the creator of jobs whose kind 
equires a permission; without it they keep the access they started with. */
  currentActor?: CurrentActor;
  /** Start work right after a job is created. Off in tests that step through ticks. */
  autoRun?: boolean;
  /** Whether an actor holds a permission; composition passes the platform's rule. Without it nobody holds any, so only a job's creator sees it. */
  permits?: (actor: Actor, permission: string) => boolean;
}

/**
 * One runner for every long-running task (imports, bulk operations, index and
 * search rebuilds, rollups, file clean-up). Jobs are rows in `job`; each tick
 * claims runnable jobs and works through them in batches within a time budget.
 * The statements live in the job store the runner is given.
 */
export class JobRunner {
  private readonly kinds = new Map<string, JobKind<never, never>>();
  private running: Promise<{ jobs: number; batches: number }> | null = null;
  private kickPending = false;
  private readonly logger: Logger;
  private readonly permits: (actor: Actor, permission: string) => boolean;

  constructor(
    private readonly store: JobStore,
    private readonly options: JobRunnerOptions = {},
  ) {
    this.logger = options.logger ?? silentLogger;
    this.permits = options.permits ?? (() => false);
  }

  register<I, S>(kind: string, def: JobKind<I, S>): void {
    if (this.kinds.has(kind)) throw new Error(`Job kind '${kind}' is already registered.`);
    this.kinds.set(kind, def as unknown as JobKind<never, never>);
  }

  async create(ctx: TenantContext, kind: string, input: Record<string, unknown>, total?: number): Promise<JobView> {
    this.assertKind(kind);
    const job = await this.store.create(ctx, kind, input, { total });
    this.started();
    return toView(job!);
  }

  /** Creates the job unless the same kind with the same input is already waiting to start. */
  async createUnlessQueued(ctx: TenantContext, kind: string, input: Record<string, unknown>): Promise<JobView | null> {
    this.assertKind(kind);
    const job = await this.store.create(ctx, kind, input, { unlessQueued: true });
    if (job) this.started();
    return job ? toView(job) : null;
  }

  /**
   * Creates the job in a tenant transaction the caller holds, so it exists only
   * if that commits; call `started()` afterwards. With `unlessQueued`, returns
   * null when the same kind with the same input is already waiting to start.
   */
  async insert(
    tx: SqlExecutor,
    ctx: TenantContext,
    kind: string,
    input: Record<string, unknown>,
    options: { total?: number; unlessQueued?: boolean } = {},
  ): Promise<JobView | null> {
    this.assertKind(kind);
    const row = await this.store.insert(tx, ctx, kind, input, options);
    return row ? toView(row) : null;
  }

  private assertKind(kind: string): void {
    if (!this.kinds.has(kind)) throw validationFailed(`Unknown job kind '${kind}'.`);
  }

  /** Starts work on newly created jobs, unless the runner only runs on ticks. */
  started(): void {
    if (this.options.autoRun !== false) this.kick();
  }

  async get(ctx: TenantContext, id: string): Promise<JobView> {
    return toView(await this.visible(ctx, id));
  }

  async items(
    ctx: TenantContext,
    id: string,
    options: { status?: JobItemResult['status']; limit?: number; offset?: number } = {},
  ): Promise<{ items: JobItemResult[] }> {
    await this.visible(ctx, id);
    const status = options.status ?? null;
    const rows = await this.store.items(ctx, id, {
      status,
      limit: Math.min(Math.max(options.limit ?? 200, 1), 1000),
      offset: Math.max(options.offset ?? 0, 0),
    });
    return {
      items: rows.map((r) => ({
        seq: r.seq,
        status: r.status as JobItemResult['status'],
        ...(r.record_id ? { recordId: r.record_id } : {}),
        ...(r.message ? { message: r.message } : {}),
        ...(r.data !== null ? { data: r.data } : {}),
      })),
    };
  }

  /** Everyone's jobs, newest first (Administration). Dates are inclusive calendar days of when the job was created. */
  async list(
    ctx: TenantContext,
    filter: { kind?: string[]; status?: JobStatus[]; startedBy?: string; from?: string; to?: string; limit: number; offset: number },
  ): Promise<{ items: (JobView & { label: string; createdByName: string | null })[]; total: number; limit: number; offset: number }> {
    if (!this.permits(ctx.actor, 'admin:jobs')) throw forbidden();
    const { rows, total } = await this.store.list(ctx, filter);
    return {
      items: rows.map((r) => ({
        ...toView(r),
        label: this.kinds.get(r.kind)?.label ?? r.kind,
        createdByName: r.created_by_name,
      })),
      total,
      limit: filter.limit,
      offset: filter.offset,
    };
  }

  /** A queued job stops at once; a running one stops before its next batch. */
  async cancel(ctx: TenantContext, id: string): Promise<JobView> {
    const job = await this.visible(ctx, id);
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') throw conflict('This job has already finished.');
    const row = await this.store.requestCancel(ctx, id);
    return toView(row!);
  }

  /** Schedules a run after the current request; safe to call often. */
  kick(): void {
    if (this.kickPending) return;
    this.kickPending = true;
    setImmediate(() => {
      this.kickPending = false;
      this.runOnce({ timeBudgetMs: 5_000 }).catch((error) => this.logger.log('ERROR', 'Background job run failed', {}, error));
    });
  }

  /** Works through runnable jobs until none remain or the time budget runs out. */
  runOnce(options: { timeBudgetMs?: number } = {}): Promise<{ jobs: number; batches: number }> {
    if (this.running) return this.running;
    this.running = this.drain(options.timeBudgetMs ?? 20_000).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async visible(ctx: TenantContext, id: string): Promise<JobRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Job not found.');
    const row = await this.store.find(ctx, id);
    if (!row || (row.created_by !== ctx.actor.id && !this.permits(ctx.actor, 'admin:jobs'))) throw notFound('Job not found.');
    return row;
  }

  private async drain(budgetMs: number): Promise<{ jobs: number; batches: number }> {
    const deadline = Date.now() + budgetMs;
    const out = { jobs: 0, batches: 0 };
    const tried = new Set<string>();
    while (Date.now() < deadline || out.jobs === 0) {
      const job = await this.claim(tried);
      if (!job) break;
      tried.add(job.id);
      out.jobs++;
      out.batches += await this.work(job, deadline);
      if (Date.now() >= deadline) break;
    }
    return out;
  }

  private claim(skip: Set<string>): Promise<JobRow | undefined> {
    const exclusive = [...this.kinds].filter(([, k]) => k.exclusive).map(([name]) => name);
    return this.store.claim([...this.kinds.keys()], exclusive, [...skip]);
  }

  /** Runs batches of one claimed job until it ends or the deadline passes; returns the number of batches. */
  private async work(job: JobRow, deadline: number): Promise<number> {
    const kind = this.kinds.get(job.kind)!;
    const ctx: TenantContext = { tenantId: job.tenant_id, actor: job.actor };
    const recheck = !!kind.requires && !!this.options.currentActor;
    const required = kind.requires?.(job.input as never);
    let checkedAt: number | undefined;
    let state = job.state;
    let batches = 0;
    try {
      for (;;) {
        if (await this.store.cancelRequested(job.id)) {
          await this.finish(job, 'cancelled', {});
          return batches;
        }
        if (recheck) {
          const version = await this.store.accessVersion(job.tenant_id);
          if (version !== undefined && version !== checkedAt) {
            const refused = await this.recheck(job, ctx, required);
            if (refused) {
              await this.finish(job, 'failed', { error: refused });
              return batches;
            }
            checkedAt = version;
          }
        }
        const heartbeat = setInterval(() => {
          this.store.extendLease(job.id).catch((error) => this.logger.log('WARNING', 'Could not extend a background job lease', { jobId: job.id }, error));
        }, HEARTBEAT_MS);
        heartbeat.unref();
        let batch: JobBatch<unknown>;
        try {
          batch = await kind.run({ ctx, jobId: job.id, input: job.input as never, state: state as never, batchSize: kind.batchSize ?? 100 });
        } finally {
          clearInterval(heartbeat);
        }
        batches++;
        state = batch.state as JobData;
        await this.store.saveBatch(job, state, batch.items ?? [], batch.progress, batch.total ?? null);
        if (batch.done) {
          await this.finish(job, 'done', { result: batch.result ?? null });
          return batches;
        }
        if (Date.now() >= deadline) {
          await this.store.releaseLease(job.id);
          return batches;
        }
      }
    } catch (error) {
      this.logger.log('ERROR', 'Background job failed', { alert: ALERT.jobFailed, jobId: job.id, kind: job.kind, tenantId: job.tenant_id }, error);
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      await this.finish(job, 'failed', { error: message });
      return batches;
    }
  }

  /**
   * Points `ctx.actor` at the creator's current access, never more than they
   * started with; returns why the job must stop when they no longer qualify.
   */
  private async recheck(job: JobRow, ctx: TenantContext, required: string | undefined): Promise<string | null> {
    const now = await this.options.currentActor!(job.tenant_id, job.actor);
    if (!now) return 'Stopped because whoever started it can no longer act in this organisation (suspended, removed or key revoked)';
    ctx.actor = { id: job.actor.id, roles: now.roles, permissions: now.permissions };
    if (required !== undefined && !this.permits(ctx.actor, required)) return `Stopped because whoever started it no longer has the permission '${required}'`;
    return null;
  }

  private async finish(job: JobRow, status: 'done' | 'failed' | 'cancelled', end: { result?: unknown; error?: string }): Promise<void> {
    const result = end.result === undefined || end.result === null ? null : JSON.stringify(end.result);
    const row = await this.store.finish(job.id, status, result, end.error ?? null);
    if (!this.options.notify || !row) return;
    const counts = await this.store.counts(job.id);
    const view = toView(row);
    const kind = this.kinds.get(job.kind)!;
    const notice = kind.notice ? kind.notice(view, counts!) : defaultNotice(kind.label, view, counts!);
    if (!notice) return;
    try {
      await this.options.notify(job.tenant_id, job.created_by, notice);
    } catch (error) {
      this.logger.log('WARNING', 'Could not notify about a finished job', { jobId: job.id }, error);
    }
  }
}

function defaultNotice(label: string, job: JobView, c: { done: number; failed: number; skipped: number }): JobNotice {
  if (job.status === 'cancelled') return { subject: `${label} cancelled`, body: `${label} was cancelled after ${job.progress} items.` };
  if (job.status === 'failed') return { subject: `${label} failed`, body: `${label} stopped: ${job.error ?? 'something went wrong'}.` };
  const parts = [`${c.done} done`, ...(c.failed ? [`${c.failed} failed`] : []), ...(c.skipped ? [`${c.skipped} skipped`] : [])];
  return { subject: `${label} finished`, body: `${label} finished: ${parts.join(', ')}.` };
}
