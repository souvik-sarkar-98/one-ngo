import { Injectable, computed, effect, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { JobRow } from '../../core/admin/admin';
import { JOB_CHIPS, type JobsAddress } from '../../core/admin/address';
import { JobsSession, failedCsv, isFinished, type JobPanel } from '../../core/admin/jobs';
import { t } from '../../core/i18n/i18n';
import type { PagedSnapshot } from '../../core/paging/paged-controller';
import { AdminBase } from '../admin-store';
import { jobColumns, jobProgress, jobRow } from '../rows';

const EMPTY: PagedSnapshot<JobRow> = { items: [], total: 0, loading: true, loadingMore: false, hasMore: false, error: '' };

/** Background jobs (`/admin/jobs?status=&job=`): everyone's jobs, a job's result with its failed items, and Cancel. */
@Injectable()
export class JobsStore extends AdminBase {
  readonly jobs = new JobsSession(this.gateway, this.nav);
  readonly state = signal<JobsAddress>(this.jobs.state);
  readonly rows = signal<PagedSnapshot<JobRow>>(EMPTY);
  readonly panel = signal<JobPanel>(this.jobs.panel.value);
  readonly chips = computed(() => {
    this.i18n.locale();
    return JOB_CHIPS.map((id) => ({ id, label: id === 'all' ? t('ui.people.status.all') : t(`ui.admin.jobs.status.${id}`) }));
  });
  readonly columns = computed(() => {
    this.i18n.locale();
    return jobColumns();
  });
  readonly rowViews = computed(() => {
    this.i18n.locale();
    const now = new Date();
    return this.rows()
      .items.filter((j) => this.matches(j.label, j.kind, j.createdByName ?? undefined))
      .map((j) => jobRow(j, now));
  });
  readonly progress = computed(() => {
    const j = this.panel().job;
    return j ? jobProgress(j) : '';
  });
  readonly running = computed(() => {
    const j = this.panel().job;
    return !!j && !isFinished(j);
  });

  constructor() {
    super();
    this.jobs.onState((s) => this.state.set(s));
    this.jobs.controller.subscribe((s) => this.rows.set(s));
    this.jobs.panel.subscribe((p) => this.panel.set(p));
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => void this.jobs.fromUrl((n) => p.get(n)));
    effect(() => {
      const j = this.panel().job;
      untracked(() => this.meta.crumbLabels.set(j ? { job: j.label ?? j.kind } : {}));
    });
  }

  async rowAction(id: string, action: string): Promise<void> {
    if (action === 'cancel') this.show(await this.jobs.cancel(id));
  }

  async cancelOpen(): Promise<void> {
    const j = this.panel().job;
    if (j) this.show(await this.jobs.cancel(j.id));
  }

  /** Hands the failed items to the browser as a CSV file. */
  download(): void {
    const j = this.panel().job;
    if (!j) return;
    const url = URL.createObjectURL(new Blob([failedCsv(this.panel().failed)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${j.label ?? j.kind} - ${t('ui.admin.jobs.failedItems')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
