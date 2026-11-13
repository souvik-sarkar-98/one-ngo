import type { ParamReader } from '../address';
import { t } from '../i18n/i18n';
import { PagedController } from '../paging/paged-controller';
import { Snapshots, type AdminGateway, type JobItem, type JobRow, type JobStatus } from './admin';
import { ADMIN_PAGE, jobsKey, jobsParams, jobsPushes, parseJobsAddress, type JobChip, type JobsAddress } from './address';
import { failure, type AdminResult, type Navigate } from './roles';

const CHIP_STATUS: Record<JobChip, JobStatus[] | undefined> = { running: ['queued', 'running'], failed: ['failed'], all: undefined };
const FINISHED = new Set<JobStatus>(['done', 'failed', 'cancelled']);

export const isFinished = (j: JobRow) => FINISHED.has(j.status);

export interface JobPanel {
  job: JobRow | null;
  failed: JobItem[];
  loading: boolean;
  error: string;
  busy: boolean;
}

/** Failed items as CSV: row, record and reason, quoted for spreadsheets. */
export function failedCsv(items: JobItem[]): string {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
  };
  return ['row,record,reason', ...items.map((i) => [i.seq, i.recordId ?? '', i.message ?? ''].map(cell).join(','))].join('\r\n') + '\r\n';
}

/**
 * Background jobs (`/admin/jobs?status=&job=`): everyone's jobs, newest first,
 * with chips Running, Failed and All; a job opens its result with the failed
 * items and, while it runs, Cancel.
 */
export class JobsSession {
  readonly controller: PagedController<JobRow, JobsAddress>;
  readonly panel = new Snapshots<JobPanel>({ job: null, failed: [], loading: false, error: '', busy: false });
  private current: JobsAddress = parseJobsAddress(() => null);
  private readonly listeners = new Set<(a: JobsAddress) => void>();

  constructor(
    private readonly gateway: AdminGateway,
    private readonly nav: Navigate,
  ) {
    this.controller = new PagedController({
      key: jobsKey,
      show: (a) => a.show,
      load: (a, offset, limit) => gateway.jobs({ ...(CHIP_STATUS[a.status] && { status: CHIP_STATUS[a.status] }), offset, limit }),
      id: (j) => j.id,
      get failure() {
        return t('ui.common.loadFailed');
      },
    });
  }

  get state(): JobsAddress {
    return this.current;
  }

  onState(fn: (a: JobsAddress) => void): () => void {
    this.listeners.add(fn);
    fn(this.current);
    return () => this.listeners.delete(fn);
  }

  async fromUrl(get: ParamReader): Promise<void> {
    const before = this.current.job;
    this.current = parseJobsAddress(get);
    for (const fn of this.listeners) fn(this.current);
    if (this.current.job !== before) void this.openPanel(this.current.job);
    await this.controller.sync(this.current);
  }

  private go(change: Partial<JobsAddress>): void {
    const next = { ...this.current, ...change, ...('status' in change && { show: ADMIN_PAGE }) };
    this.nav.navigate(jobsParams(next), !jobsPushes(this.current, next));
  }

  selectChip(id: string): void {
    if (id !== this.current.status) this.go({ status: id as JobChip });
  }

  open(id: string): void {
    this.go({ job: id });
  }

  close(): void {
    this.go({ job: undefined });
  }

  loadMore(): void {
    const r = this.controller.snapshot;
    if (r.hasMore && !r.loading && !r.loadingMore && !r.error) this.go({ show: Math.max(this.current.show, r.items.length) + ADMIN_PAGE });
  }

  async cancel(id: string): Promise<AdminResult> {
    this.panel.set({ busy: true });
    try {
      const job = await this.gateway.cancelJob(id);
      const row = this.controller.snapshot.items.find((j) => j.id === id);
      this.controller.replaceRow({ ...row, ...job });
      if (this.panel.value.job?.id === id) this.panel.set({ job: { ...this.panel.value.job, ...job } });
      this.panel.set({ busy: false });
      return { ok: true, message: t('ui.admin.jobs.cancelled') };
    } catch (e) {
      this.panel.set({ busy: false });
      return { ok: false, message: failure(e) };
    }
  }

  private async openPanel(id: string | undefined): Promise<void> {
    if (!id) return this.panel.set({ job: null, failed: [], error: '', loading: false });
    const row = this.controller.snapshot.items.find((j) => j.id === id) ?? null;
    this.panel.set({ job: row, failed: [], loading: true, error: '' });
    try {
      const job = await this.gateway.job(id);
      const failed = await this.gateway.failedItems(id);
      if (this.current.job === id) this.panel.set({ job: { ...row, ...job }, failed, loading: false });
    } catch (e) {
      if (this.current.job === id) this.panel.set({ loading: false, error: failure(e) });
    }
  }
}
