import { t } from '../../i18n/i18n';
import type { FieldDef } from '../../models';
import type { Suggestion } from '../../ui-logic/autocomplete';
import type { FormValues } from '../record/forms';
import { asGatewayError } from '../gateway/gateway';
import {
  jobSummary,
  operationBody,
  operationFields,
  operationValues,
  summarise,
  type BulkGateway,
  type BulkJob,
  type BulkOperation,
  type BulkSummary,
  type BulkTarget,
} from './selection';
import type { ListSpec } from '../spec';

export interface BulkSnapshot {
  /** The operation whose form, progress or result the panel shows; null when it is closed. */
  op: BulkOperation | null;
  /** The panel's title: the operation's label, or a generic one for a job opened from its notification. */
  label: string;
  count: number;
  values: FormValues;
  /** What chosen people and records are shown as, by id. */
  titles: Record<string, string>;
  errors: Record<string, string>;
  general: string[];
  busy: boolean;
  job: BulkJob | null;
  summary: BulkSummary | null;
  error: string;
}

export interface BulkHooks {
  /** An operation finished (at once or as a job); the list reloads and the selection clears. */
  finished(): void;
  wait?(ms: number): Promise<void>;
}

const POLL_MS = 1500;
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const CLOSED: BulkSnapshot = { op: null, label: '', count: 0, values: {}, titles: {}, errors: {}, general: [], busy: false, job: null, summary: null, error: '' };

/**
 * One bulk operation in the panel, independent of how it is drawn: its
 * form asked once for every record, the run, a large run's job progress,
 * and the result summary.
 */
export class BulkSession {
  private snap: BulkSnapshot = CLOSED;
  private readonly listeners = new Set<(s: BulkSnapshot) => void>();
  private watching: object | null = null;

  constructor(
    private readonly gateway: BulkGateway,
    private readonly spec: ListSpec,
    /** How a record is named in the problems list: its number or title when loaded. */
    private readonly name: (id: string) => string,
    private readonly hooks: BulkHooks,
  ) {}

  get snapshot(): BulkSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: BulkSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  open(op: BulkOperation, count: number): void {
    this.watching = null;
    this.set({ ...CLOSED, op, label: op.label, count, values: operationValues(op) });
  }

  fields(): FieldDef[] {
    return this.snap.op ? operationFields(this.spec, this.snap.op, this.snap.values) : [];
  }

  setValues(values: FormValues): void {
    this.set({ values, errors: {}, general: [] });
  }

  /** A person or record chosen in a picker field of the form. */
  choose(key: string, option: Suggestion | null): void {
    this.set({ values: { ...this.snap.values, [key]: option?.id ?? '' }, ...(option ? { titles: { ...this.snap.titles, [option.id]: option.label } } : {}) });
  }

  async submit(target: BulkTarget): Promise<void> {
    const op = this.snap.op;
    if (!op || this.snap.busy) return;
    const checked = operationBody(this.spec, op, this.snap.values);
    if ('errors' in checked) return this.set({ errors: checked.errors, general: checked.general });
    this.set({ busy: true, error: '', general: [] });
    try {
      const answer = await this.gateway.run(this.spec.type.key, target, checked.body);
      if (this.snap.op !== op) return;
      if ('results' in answer) {
        this.set({ busy: false, summary: summarise(answer.results, this.name) });
        this.hooks.finished();
      } else {
        this.set({ busy: false, count: answer.total });
        await this.watch(answer.jobId);
      }
    } catch (e) {
      const err = asGatewayError(e, t('ui.common.somethingWentWrong'));
      this.set({ busy: false, general: [err.message, ...(err.issues ?? []).map((i) => i.message)] });
    }
  }

  /** Shows a bulk job's progress or result, e.g. from its notification. */
  async follow(jobId: string): Promise<void> {
    if (this.snap.job?.id === jobId) return;
    this.set({ ...CLOSED, label: t('ui.bulk.operation') });
    await this.watch(jobId);
  }

  async stop(): Promise<void> {
    const job = this.snap.job;
    if (!job || FINISHED.has(job.status)) return;
    try {
      this.set({ job: await this.gateway.cancelJob(job.id) });
    } catch (e) {
      this.set({ error: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
    }
  }

  close(): void {
    this.watching = null;
    this.set(CLOSED);
  }

  dispose(): void {
    this.watching = null;
    this.listeners.clear();
  }

  private async watch(jobId: string): Promise<void> {
    const me = {};
    this.watching = me;
    const wait = this.hooks.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      while (this.watching === me) {
        const job = await this.gateway.job(jobId);
        if (this.watching !== me) return;
        this.set({ job, count: job.total ?? this.snap.count });
        if (FINISHED.has(job.status)) {
          const failed = await this.gateway.failedItems(jobId);
          if (this.watching !== me) return;
          this.watching = null;
          this.set({ summary: jobSummary(job, failed, this.name) });
          this.hooks.finished();
          return;
        }
        await wait(POLL_MS);
      }
    } catch (e) {
      if (this.watching === me) {
        this.watching = null;
        this.set({ error: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
      }
    }
  }

  private set(patch: Partial<BulkSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }
}
