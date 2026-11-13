import type { Actor, SqlExecutor, TenantContext } from '../../postgres/db.js';

/** What the job runner needs from the place jobs are kept. The PostgreSQL implementation is in src/infrastructure/postgres/stores/job-store.ts. */

export type JobData = { [key: string]: unknown };

export interface JobRow {
  id: string;
  tenant_id: string;
  kind: string;
  status: string;
  input: JobData;
  state: JobData;
  actor: Actor;
  progress: number;
  total: number | null;
  result: JobData | null;
  error: string | null;
  cancel_requested: boolean;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface JobItemRow {
  seq: number;
  status: string;
  record_id: string | null;
  message: string | null;
  data: unknown;
}

export interface JobItemWrite {
  seq: number;
  status: 'done' | 'failed' | 'skipped';
  recordId?: string;
  message?: string;
  data?: unknown;
}

export interface JobListFilter {
  kind?: string[];
  status?: string[];
  startedBy?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export interface JobStore {
  /** Inserts in a tenant transaction the caller holds; null when `unlessQueued` and the same kind with the same input is waiting. */
  insert(tx: SqlExecutor, ctx: TenantContext, kind: string, input: Record<string, unknown>, options: { total?: number; unlessQueued?: boolean }): Promise<JobRow | null>;
  /** Inserts in its own tenant transaction. */
  create(ctx: TenantContext, kind: string, input: Record<string, unknown>, options: { total?: number; unlessQueued?: boolean }): Promise<JobRow | null>;
  find(ctx: TenantContext, id: string): Promise<JobRow | undefined>;
  items(ctx: TenantContext, id: string, options: { status: string | null; limit: number; offset: number }): Promise<JobItemRow[]>;
  list(ctx: TenantContext, filter: JobListFilter): Promise<{ rows: (JobRow & { created_by_name: string | null })[]; total: number }>;
  /** A queued job is cancelled at once; any other only gets the request flag. */
  requestCancel(ctx: TenantContext, id: string): Promise<JobRow | undefined>;
  /** Takes the oldest runnable job of the registered kinds, skipping `skip`, with a lease. */
  claim(kinds: string[], exclusive: string[], skip: string[]): Promise<JobRow | undefined>;
  /** Null when the job is gone. */
  cancelRequested(jobId: string): Promise<boolean | undefined>;
  /** The organisation's access version; undefined when the organisation is gone. It moves whenever roles, memberships or API keys change. */
  accessVersion(tenantId: string): Promise<number | undefined>;
  extendLease(jobId: string): Promise<void>;
  releaseLease(jobId: string): Promise<void>;
  /** Saves one batch: its items, the job state, progress and total, and a fresh lease. */
  saveBatch(job: JobRow, state: JobData, items: JobItemWrite[], progress: number, total: number | null): Promise<void>;
  /** Ends a running job; undefined when it was no longer running. */
  finish(jobId: string, status: 'done' | 'failed' | 'cancelled', result: string | null, error: string | null): Promise<JobRow | undefined>;
  counts(jobId: string): Promise<{ done: number; failed: number; skipped: number } | undefined>;
}
