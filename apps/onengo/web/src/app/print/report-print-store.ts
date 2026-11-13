import { Injectable, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { t } from '../core/i18n/i18n';
import { paramsFromQuery, type ParamValue, type ReportFormat, type ReportParameter } from '../reports/report-files';
import { Api, ApiError } from '../services/api';
import { FileApi } from '../services/file-api';

/**
 * Loads a report page for the print view. With parameters it is a preview that
 * keeps nothing; with `?published=` it is a file already kept.
 */
@Injectable()
export class ReportPrintStore {
  private readonly api = inject(Api);
  private readonly files = inject(FileApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  readonly html = signal('');
  readonly format = signal<ReportFormat>('pdf');
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly publishedId = signal('');
  /** True when the person asked to download a kept PDF, which opens the print dialog once the page shows. */
  readonly printOnLoad = signal(false);
  private key = '';
  private params: Record<string, ParamValue> = {};

  async load(key: string): Promise<void> {
    this.key = key;
    const query = this.route.snapshot.queryParamMap;
    const published = query.get('published') ?? '';
    this.publishedId.set(published);
    this.printOnLoad.set(false);
    this.loading.set(true);
    this.error.set('');
    try {
      if (published) {
        const out = await this.api.get<{ html: string; format: ReportFormat }>(`/api/reports/published/${encodeURIComponent(published)}`);
        this.format.set(out.format);
        this.html.set(out.html);
        this.printOnLoad.set(query.get('download') === '1' && out.format === 'pdf');
        return;
      }
      const { report } = await this.api.get<{ report: { parameters: ReportParameter[] } }>(`/api/reports/${encodeURIComponent(key)}`);
      this.params = paramsFromQuery(report.parameters, (name) => query.get(name));
      const out = await this.api.post<{ html: string; format: ReportFormat }>(`/api/reports/${encodeURIComponent(key)}/preview`, { params: this.params });
      this.format.set(out.format);
      this.html.set(out.html);
    } catch (e) {
      this.error.set(failure(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Runs the report again on the server and keeps the file, then shows it on the report's list. */
  async publish(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const out = await this.api.post<{ id: string }>(`/api/reports/${encodeURIComponent(this.key)}/publish`, { params: this.params });
      await this.router.navigate(['/reports', this.key], { queryParams: { published: out.id }, replaceUrl: true });
    } catch (e) {
      this.error.set(failure(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Downloads the kept workbook of an Excel report. */
  async downloadWorkbook(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const out = await this.files.download('GET', `/api/reports/published/${encodeURIComponent(this.publishedId())}/file`);
      if ('json' in out) return;
      const url = URL.createObjectURL(out.body);
      const link = document.createElement('a');
      link.href = url;
      link.download = out.fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      this.error.set(failure(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Back to where the person came from, or to the report when the view was opened on its own. */
  back(): void {
    const previous = (history.state as { navigationId?: number } | null)?.navigationId ?? 1;
    if (previous > 1) this.location.back();
    else void this.router.navigate(['/reports', this.key]);
  }
}

const failure = (e: unknown): string => (e instanceof ApiError && e.message ? e.message : t('ui.reports.failed'));
