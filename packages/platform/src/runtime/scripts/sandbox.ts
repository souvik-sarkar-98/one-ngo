import { Worker } from 'node:worker_threads';
import { ScriptFailure } from '../../domain/script-failure.js';
import type { BeforeSaveInput, RecordScripts, ScriptResult, ScriptRunInput, ScriptRunResult } from '../records/ports/record-scripts.js';
import { HOOK_OUTPUT, ScriptEffectsValidator } from './effects.js';
import type { EffectCheck, EffectPolicy } from './types.js';
import type { WorkerReply, WorkerTask } from './sandbox-worker.js';

export type { BeforeSaveInput, ScriptResult, ScriptRunInput, ScriptRunResult };
export { ScriptFailure };

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_MEMORY_MB = 16;
const MAX_OUTPUT_BYTES = 256 * 1024;
/** The whole input (record, previous, inputs) has the same cap as the output. */
export const MAX_INPUT_BYTES = 256 * 1024;
/** Try it runs stop sooner than published scripts, which may take up to 1 s. */
export const TRY_IT_MAX_TIMEOUT_MS = 250;

// The script body runs as `new Function('ctx', __code)` inside QuickJS. It sees
// only a JSON copy of its input; nothing from the host is reachable. Effects
// are only data pushed onto ctx.effects; the helpers build the same objects.
const HARNESS = `(function () {
  const __logs = [];
  const ctx = JSON.parse(__input);
  const __freeze = function (o) {
    if (o && typeof o === 'object') { Object.freeze(o); for (const k in o) __freeze(o[k]); }
    return o;
  };
  if (ctx.inputs !== undefined) __freeze(ctx.inputs);
  ctx.effects = [];
  const __push = function (e) { ctx.effects.push(e); return e; };
  ctx.propose = Object.freeze({
    journal: function (j) { return __push(Object.assign({ type: 'ledger.propose' }, j)); },
    record: function (recordType, data) { return __push({ type: 'records.create', recordType: recordType, data: data }); },
    update: function (recordType, id, expectedVersion, data) {
      return __push({ type: 'records.update', recordType: recordType, id: id, expectedVersion: expectedVersion, data: data });
    },
    notify: function (template, to, options) { return __push(Object.assign({ type: 'notify', template: template, to: to }, options || {})); },
    connector: function (connector, body) { return __push({ type: 'connector.call', connector: connector, body: body || {} }); },
  });
  ctx.log = function () {
    if (__logs.length >= 50) return;
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      const a = arguments[i];
      parts.push(typeof a === 'string' ? a : JSON.stringify(a));
    }
    __logs.push(parts.join(' ').slice(0, 500));
  };
  ctx.fail = function (message) { throw { __scriptFail: String(message) }; };
  try {
    const fn = new Function('ctx', __code);
    fn(ctx);
    return JSON.stringify({ ok: true, record: ctx.record, effects: ctx.effects, logs: __logs });
  } catch (e) {
    if (e instanceof InternalError) throw e;
    if (e && typeof e === 'object' && '__scriptFail' in e) {
      return JSON.stringify({ ok: false, fail: e.__scriptFail, logs: __logs });
    }
    return JSON.stringify({ ok: false, error: String(e && e.message || e), logs: __logs });
  }
})()`;

export interface ScriptPoolOptions {
  /** Worker threads, started on first use. Each costs about 10 MB idle and at most its script's memory limit more. */
  size?: number;
  /** How long past a script's own limit the main thread waits before it ends and replaces the worker. Tests use a negative value. */
  graceMs?: number;
  /** Workers one organisation may hold at once; the rest stay free for the others. */
  orgConcurrency?: number;
  /** Script time one organisation may use per window, in ms. */
  orgBudgetMs?: number;
  budgetWindowMs?: number;
  /** Runs one organisation may have waiting for a worker. */
  maxQueuedPerOrg?: number;
  /** A run still waiting for a worker after this long is refused. */
  maxQueueWaitMs?: number;
}

export interface ScriptPoolStats {
  workers: number;
  busy: number;
  queued: number;
  /** Workers ended for overrunning, or lost, and started again. */
  replaced: number;
  threadIds: number[];
}

interface Job {
  tenantId: string;
  trial: boolean;
  task: Omit<WorkerTask, 'id'>;
}

interface Pending extends Job {
  id: number;
  queuedAt: number;
  waitTimer?: NodeJS.Timeout;
  resolve: (reply: WorkerReply) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  current?: Pending;
  startedAt?: number;
  killTimer?: NodeJS.Timeout;
}

/** Where the worker thread's script is and how to start it: the esbuild bundle's `dist/sandbox-worker.js`, or the TypeScript file under tsx. Composition supplies it. */
export interface ScriptWorkerEntry {
  file: string;
  execArgv?: string[];
}

/**
 * Runs scripts on a few worker threads so the event loop never waits for one.
 * QuickJS interrupts a script at its own limit; if a worker has not answered
 * `graceMs` later, the main thread ends it and starts a fresh one. Each
 * organisation may hold at most `orgConcurrency` workers and `orgBudgetMs` of
 * script time per window, so one organisation cannot occupy every worker.
 */
export class ScriptPool {
  private readonly size: number;
  private readonly graceMs: number;
  private readonly orgConcurrency: number;
  private readonly orgBudgetMs: number;
  private readonly budgetWindowMs: number;
  private readonly maxQueuedPerOrg: number;
  private readonly maxQueueWaitMs: number;
  private readonly slots: Slot[] = [];
  private queue: Pending[] = [];
  private readonly spent = new Map<string, { at: number; ms: number }[]>();
  private nextId = 1;
  private replaced = 0;

  constructor(
    private readonly entry: ScriptWorkerEntry,
    options: ScriptPoolOptions = {},
  ) {
    this.size = Math.max(1, options.size ?? 2);
    this.graceMs = options.graceMs ?? 200;
    this.orgConcurrency = Math.max(1, options.orgConcurrency ?? this.size - 1);
    this.orgBudgetMs = options.orgBudgetMs ?? 20_000;
    this.budgetWindowMs = options.budgetWindowMs ?? 60_000;
    this.maxQueuedPerOrg = options.maxQueuedPerOrg ?? 20;
    this.maxQueueWaitMs = options.maxQueueWaitMs ?? 5_000;
  }

  stats(): ScriptPoolStats {
    return {
      workers: this.slots.length,
      busy: this.slots.filter((s) => s.current).length,
      queued: this.queue.length,
      replaced: this.replaced,
      threadIds: this.slots.map((s) => s.worker.threadId),
    };
  }

  /** Ends every worker; later runs start new ones. */
  async close(): Promise<void> {
    const slots = this.slots.splice(0);
    for (const p of this.queue.splice(0)) this.fail(p, new ScriptFailure('script_failed', 'The script runner stopped.'));
    await Promise.all(
      slots.map((s) => {
        clearTimeout(s.killTimer);
        if (s.current) this.fail(s.current, new ScriptFailure('script_failed', 'The script runner stopped.'));
        return s.worker.terminate();
      }),
    );
  }

  execute(job: Job): Promise<WorkerReply> {
    const { tenantId } = job;
    if (this.used(tenantId) >= this.orgBudgetMs) {
      return Promise.reject(new ScriptFailure('script_limit', 'This organisation has used its script time for the last minute. Try again shortly.'));
    }
    const mine = this.queue.filter((p) => p.tenantId === tenantId);
    if (job.trial && (mine.some((p) => p.trial) || this.slots.some((s) => s.current?.tenantId === tenantId && s.current.trial))) {
      return Promise.reject(new ScriptFailure('script_limit', 'Another Try it run for this organisation is still going.'));
    }
    if (mine.length >= this.maxQueuedPerOrg) {
      return Promise.reject(new ScriptFailure('script_limit', 'Too many scripts for this organisation are waiting to run. Try again shortly.'));
    }
    return new Promise<WorkerReply>((resolve, reject) => {
      const pending: Pending = { ...job, id: this.nextId++, queuedAt: performance.now(), resolve, reject };
      pending.waitTimer = setTimeout(() => {
        this.queue = this.queue.filter((p) => p !== pending);
        reject(new ScriptFailure('script_limit', 'The script service is busy. Try again shortly.'));
      }, this.maxQueueWaitMs);
      pending.waitTimer.unref();
      this.queue.push(pending);
      this.pump();
    });
  }

  private used(tenantId: string): number {
    const cutoff = performance.now() - this.budgetWindowMs;
    const entries = (this.spent.get(tenantId) ?? []).filter((e) => e.at >= cutoff);
    if (entries.length) this.spent.set(tenantId, entries);
    else this.spent.delete(tenantId);
    return entries.reduce((n, e) => n + e.ms, 0);
  }

  private charge(tenantId: string, ms: number): void {
    const entries = this.spent.get(tenantId) ?? [];
    entries.push({ at: performance.now(), ms });
    this.spent.set(tenantId, entries);
  }

  private pump(): void {
    while (this.slots.length < Math.min(this.size, this.queue.length + this.slots.filter((s) => s.current).length)) this.spawn();
    for (const slot of this.slots) {
      if (!slot.ready || slot.current) continue;
      const running = (t: string) => this.slots.filter((s) => s.current?.tenantId === t).length;
      const next = this.queue.find((p) => running(p.tenantId) < this.orgConcurrency);
      if (!next) return;
      this.queue = this.queue.filter((p) => p !== next);
      this.dispatch(slot, next);
    }
  }

  private spawn(): Slot {
    const worker = new Worker(this.entry.file, {
      execArgv: this.entry.execArgv ?? [],
      workerData: { harness: HARNESS, maxOutputBytes: MAX_OUTPUT_BYTES },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
    });
    worker.unref();
    const slot: Slot = { worker, ready: false };
    this.slots.push(slot);
    worker.on('message', (msg: WorkerReply | { ready: true }) => {
      if ('ready' in msg) {
        slot.ready = true;
        this.pump();
        return;
      }
      const p = slot.current;
      if (!p || msg.id !== p.id) return;
      this.finish(slot, p);
      p.resolve(msg);
      this.pump();
    });
    worker.on('error', (err: Error & { code?: string }) => this.lost(slot, err));
    worker.on('exit', () => this.lost(slot));
    return slot;
  }

  private dispatch(slot: Slot, p: Pending): void {
    clearTimeout(p.waitTimer);
    slot.current = p;
    slot.startedAt = performance.now();
    slot.worker.ref();
    slot.killTimer = setTimeout(() => this.overrun(slot, p), Math.max(0, p.task.timeoutMs + this.graceMs));
    slot.worker.postMessage({ ...p.task, id: p.id } satisfies WorkerTask);
  }

  /** Clears the slot after a run, charging its time to the organisation. */
  private finish(slot: Slot, p: Pending): number {
    clearTimeout(slot.killTimer);
    const ms = Math.round(performance.now() - (slot.startedAt ?? performance.now()));
    this.charge(p.tenantId, ms);
    slot.current = undefined;
    slot.startedAt = undefined;
    slot.worker.unref();
    return ms;
  }

  private overrun(slot: Slot, p: Pending): void {
    if (slot.current !== p) return;
    const ms = this.finish(slot, p);
    this.retire(slot);
    p.reject(new ScriptFailure('script_limit', `Script exceeded its ${p.task.timeoutMs} ms time limit.`, [], ms));
    this.pump();
  }

  /** A worker that crashed, ran out of memory or exited on its own. */
  private lost(slot: Slot, err?: Error & { code?: string }): void {
    if (!this.slots.includes(slot)) return;
    const p = slot.current;
    if (p) {
      const ms = this.finish(slot, p);
      p.reject(
        err?.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new ScriptFailure('script_limit', 'Script exceeded its memory limit.', [], ms)
          : new ScriptFailure('script_failed', 'The script runner stopped unexpectedly.', [], ms),
      );
    }
    const neverStarted = !slot.ready;
    this.retire(slot);
    if (neverStarted && !this.slots.some((s) => s.ready)) {
      for (const q of this.queue.splice(0)) this.fail(q, new ScriptFailure('script_failed', `The script runner could not start: ${err?.message ?? 'it exited'}.`));
      return;
    }
    this.pump();
  }

  private retire(slot: Slot): void {
    const i = this.slots.indexOf(slot);
    if (i < 0) return;
    this.slots.splice(i, 1);
    this.replaced++;
    void slot.worker.terminate();
  }

  private fail(p: Pending, err: Error): void {
    clearTimeout(p.waitTimer);
    p.reject(err);
  }
}

export class ScriptSandbox implements RecordScripts {
  private readonly effects: ScriptEffectsValidator;
  private readonly pool: ScriptPool;

  /** `schemaDir` holds the effect schema (scriptEffects.schema.json); `worker` is where the script thread starts. */
  constructor(schemaDir: string, worker: ScriptWorkerEntry, pool: ScriptPool = new ScriptPool(worker)) {
    this.pool = pool;
    this.effects = new ScriptEffectsValidator(schemaDir);
  }

  /** Checks a script's output against the effect schema and the declared policy. */
  checkEffects(output: unknown, policy: EffectPolicy): EffectCheck {
    return this.effects.check(output, policy);
  }

  /** Runs a before-save script and returns the record it leaves; any proposed effects are ignored. */
  async runBeforeSave(input: BeforeSaveInput): Promise<ScriptResult> {
    const out = await this.run({ ...input, hook: 'beforeSave' });
    return { record: out.output.record!, logs: out.logs, durationMs: out.durationMs };
  }

  /**
   * Runs a script on any hook. Hooks that may change the record must leave
   * ctx.record as an object; on the others it is not returned. Proposed
   * effects come back unchecked, for the effect validator.
   */
  async run(input: ScriptRunInput): Promise<ScriptRunResult> {
    const payload = JSON.stringify({
      record: input.record,
      previous: input.previous,
      status: input.status,
      recordType: input.recordType,
      user: input.user,
      ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
      ...input.extra,
    });
    const cap = input.maxOutputBytes ?? MAX_INPUT_BYTES;
    if (payload.length > cap) throw new ScriptFailure('script_limit', 'Script input is too large.');
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const reply = await this.pool.execute({
      tenantId: input.tenantId ?? '',
      trial: input.trial ?? false,
      task: {
        payload,
        code: input.code,
        timeoutMs,
        memoryMb: input.memoryMb ?? DEFAULT_MEMORY_MB,
        ...(input.maxOutputBytes ? { maxOutputBytes: input.maxOutputBytes } : {}),
      },
    });
    const { durationMs } = reply;
    if ('error' in reply) {
      if (/interrupted/i.test(reply.error)) {
        throw new ScriptFailure('script_limit', `Script exceeded its ${timeoutMs} ms time limit.`, [], durationMs);
      }
      if (/out of memory|stack overflow/i.test(reply.error)) {
        throw new ScriptFailure('script_limit', 'Script exceeded its memory limit.', [], durationMs);
      }
      throw new ScriptFailure('script_failed', `Script error: ${reply.error}`, [], durationMs);
    }
    if ('tooLarge' in reply) throw new ScriptFailure('script_limit', 'Script output is too large.', [], durationMs);
    const out = JSON.parse(reply.raw) as
      | { ok: true; record: unknown; effects: unknown; logs: string[] }
      | { ok: false; fail?: string; error?: string; logs: string[] };
    if (!out.ok) {
      if (out.fail !== undefined) throw new ScriptFailure('script_failed', out.fail, out.logs, durationMs);
      throw new ScriptFailure('script_failed', `Script error: ${out.error}`, out.logs, durationMs);
    }
    const takesRecord = HOOK_OUTPUT[input.hook].record;
    if (takesRecord && (!out.record || typeof out.record !== 'object' || Array.isArray(out.record))) {
      throw new ScriptFailure('script_failed', 'Script must leave ctx.record as an object.', out.logs, durationMs);
    }
    if (!Array.isArray(out.effects)) throw new ScriptFailure('script_failed', 'Script must leave ctx.effects as a list.', out.logs, durationMs);
    return {
      output: { ...(takesRecord ? { record: out.record as Record<string, unknown> } : {}), effects: out.effects },
      logs: out.logs,
      durationMs,
    };
  }
}
