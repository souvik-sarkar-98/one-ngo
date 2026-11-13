import type { TenantContext } from '../../../domain/ports/tenant-context.js';

/** The job contracts the record runtime and its use cases rely on; the runner itself is infrastructure. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobItemResult {
  /** Position of the item in the job (for example the CSV row); unique per job. */
  seq: number;
  status: 'done' | 'failed' | 'skipped';
  recordId?: string;
  message?: string;
  data?: unknown;
}

export interface JobBatch<S> {
  state: S;
  items?: JobItemResult[];
  /** Items handled so far, across all batches. */
  progress: number;
  total?: number;
  done: boolean;
  result?: Record<string, unknown>;
}

export interface JobRun<I, S> {
  ctx: TenantContext;
  jobId: string;
  input: I;
  /** What the previous batch returned; `{}` for the first. */
  state: S;
  batchSize: number;
}

export interface JobView {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  total: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
  cancelRequested: boolean;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobNotice {
  subject: string;
  body: string;
  recordId?: string;
  link?: string;
}

export interface JobKind<I = Record<string, unknown>, S = Record<string, unknown>> {
  /** Label used in the finished notification, for example "Import". */
  label: string;
  /** At most one exclusive job per organisation runs at a time; the rest wait in order. */
  exclusive?: boolean;
  batchSize?: number;
  /**
   * For jobs that act with their creator's rights: the permission the creator must
   * still hold (undefined: only that they can still act here). Every batch then runs
   * with the creator's current access, narrowed to what they held when they started
   * it, and the job stops once they no longer qualify.
   */
  requires?(input: I): string | undefined;
  /** Handles the next batch. Each batch is saved before the next starts, so a stopped job resumes from its last state. */
  run(job: JobRun<I, S>): Promise<JobBatch<S>>;
  /** The notification sent to the creator when the job ends; a summary of the items when absent. */
  notice?(job: JobView, counts: { done: number; failed: number; skipped: number }): JobNotice | null;
}

/** What the record runtime and import/export/bulk use cases ask of the job runner. */
export interface JobRunner {
  register<I, S>(kind: string, def: JobKind<I, S>): void;
  create(ctx: TenantContext, kind: string, input: Record<string, unknown>, total?: number): Promise<JobView>;
  get(ctx: TenantContext, id: string): Promise<JobView>;
  /** A queued job stops at once; a running one stops before its next batch. */
  cancel(ctx: TenantContext, id: string): Promise<JobView>;
}
