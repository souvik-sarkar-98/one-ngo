import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { PageFrame } from '@onengo/web-kit';
import { t } from '../core/i18n/i18n';
import type { FormValues } from '../core/records/record/forms';
import { Api, ApiError } from '../services/api';
import { FileApi } from '../services/file-api';
import { TranslatePipe } from '../services/i18n';
import { ScreenMeta } from '../services/screen-meta';
import { CreateButton } from '../ui/create-button';
import { ListCreateSheet } from '../ui/form-panel';
import { ScreenHeading } from '../ui/screen-heading';
import { Viewport } from '../ui/viewport';
import {
  missingParameters,
  parameterFields,
  parameterQuery,
  parameterSummary,
  parameterValues,
  shortDate,
  valuesFromQuery,
  type ReportFormat,
  type ReportParameter,
} from './report-files';

interface ReportView {
  key: string;
  label: string;
  format: ReportFormat;
  parameters: ReportParameter[];
  group: { key: string; label: string } | null;
}

interface PublishedFile {
  id: string;
  title: string;
  format: ReportFormat;
  params: Record<string, unknown>;
  createdByName: string | null;
  createdAt: string;
}

/**
 * One report, the same screen as a record type: the files already published
 * from it, and New report, which opens the record create panel with the
 * report's parameters. Preview there opens the print page; nothing is kept
 * until Publish on that page.
 */
@Component({
  selector: 'app-report-screen',
  imports: [PageFrame, TranslatePipe, ScreenHeading, ListCreateSheet, CreateButton],
  styleUrls: ['../ui/styles/na-list-dashboard.css', '../ui/styles/title-action.css'],
  styles: `
    :host { display: block; }
    .report__format { margin: -4px 0 12px; }
    .report-files.panel { overflow-x: auto; }
    .report-files table { width: 100%; }
    .report-files tr.is-new td { background: var(--primary-50, #fff7ed); }
    .report-files th:last-child, .report-files td:last-child { text-align: end; white-space: nowrap; width: 1%; }
    .report-cards { list-style: none; margin: 0; padding: 0; }
    .report-card { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 12px 14px; }
    .report-card + .report-card { border-top: 1px solid var(--panel-border); }
    .report-card.is-new { background: var(--primary-50, #fff7ed); }
    .report-card__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .report-card__actions { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }
    .sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  `,
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="report()?.label || ('ui.nav.reports' | t)" />
        @if (report() && !narrow()) {
          <button type="button" class="app-btn app-btn--primary admin__title-action" (click)="openCreate()">{{ 'ui.reports.new' | t }}</button>
        }
      </div>
      @if (error()) {
        <div class="notice error" role="alert">{{ error() }}</div>
      } @else if (loading()) {
        <p class="muted">{{ 'ui.common.loading' | t }}</p>
      } @else if (report(); as item) {
        <p class="muted report__format">{{ (item.format === 'excel' ? 'ui.reports.formatExcel' : 'ui.reports.formatPdf') | t }}</p>
        @if (justPublished()) {
          <div class="notice ok" role="status">{{ (item.format === 'excel' ? 'ui.reports.publishedExcel' : 'ui.reports.publishedPdf') | t }}</div>
        }
        @if (downloadError()) {
          <div class="notice error" role="alert">{{ downloadError() }}</div>
        }
        @if (!files().length) {
          <p class="muted">{{ 'ui.reports.noFiles' | t }}</p>
        } @else if (narrow()) {
          <ul class="panel report-cards">
            @for (file of files(); track file.id) {
              <li class="report-card" [class.is-new]="file.id === justPublished()">
                <span class="report-card__text">
                  <strong>{{ day(file.createdAt) }}</strong>
                  <span class="list-row__sub">{{ summary(file) }}</span>
                  <span class="list-row__sub">{{ file.createdByName ?? '' }}</span>
                </span>
                <span class="report-card__actions">
                  <button type="button" class="app-btn app-btn--secondary" (click)="preview(file)">{{ 'ui.reports.preview' | t }}</button>
                  <button type="button" class="app-btn app-btn--secondary" [disabled]="busy()" (click)="download(file)">{{ 'ui.reports.downloadFile' | t }}</button>
                </span>
              </li>
            }
          </ul>
        } @else {
          <div class="panel report-files">
            <table>
              <thead>
                <tr>
                  <th scope="col">{{ 'ui.reports.colGenerated' | t }}</th>
                  <th scope="col">{{ 'ui.reports.colParameters' | t }}</th>
                  <th scope="col">{{ 'ui.reports.colPreparedBy' | t }}</th>
                  <th scope="col"><span class="sr">{{ 'ui.reports.colActions' | t }}</span></th>
                </tr>
              </thead>
              <tbody>
                @for (file of files(); track file.id) {
                  <tr [class.is-new]="file.id === justPublished()">
                    <td><strong>{{ day(file.createdAt) }}</strong></td>
                    <td>{{ summary(file) }}</td>
                    <td>{{ file.createdByName ?? '' }}</td>
                    <td>
                      <div class="app-btn-group">
                        <button type="button" class="app-btn app-btn--secondary" (click)="preview(file)">{{ 'ui.reports.preview' | t }}</button>
                        <button type="button" class="app-btn app-btn--secondary" [disabled]="busy()" (click)="download(file)">{{ 'ui.reports.downloadFile' | t }}</button>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (narrow()) {
          <div class="list-dashboard__floating-actions">
            <app-create-button [label]="'ui.reports.new' | t" (pressed)="openCreate()" />
          </div>
        }
        <app-list-create-sheet
          [open]="creating()"
          [title]="createTitle()"
          [hint]="'ui.reports.createHint' | t"
          [saveLabel]="'ui.reports.preview' | t"
          [fields]="fields()"
          [values]="values()"
          [errors]="errors()"
          idPrefix="report-param"
          (valuesChange)="setValues($event)"
          (dismissed)="closeCreate()"
          (saved)="runPreview()" />
      }
    </app-page-frame>
  `,
})
export class ReportScreen {
  private readonly api = inject(Api);
  private readonly files$ = inject(FileApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(ScreenMeta);
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  readonly narrow = inject(Viewport).narrow;
  readonly key = input.required<string>();
  readonly report = signal<ReportView | null>(null);
  readonly files = signal<PublishedFile[]>([]);
  readonly values = signal<FormValues>({});
  readonly errors = signal<Record<string, string>>({});
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly downloadError = signal('');
  readonly creating = computed(() => !!this.report() && this.query().get('create') === 'new');
  readonly justPublished = computed(() => this.query().get('published') ?? '');
  readonly fields = computed(() => parameterFields(this.report()?.parameters ?? []));
  readonly createTitle = computed(() => t('ui.reports.newNamed', { report: (this.report()?.label ?? '').toLowerCase() }));

  constructor() {
    effect(() => {
      const key = this.key();
      untracked(() => void this.load(key));
    });
    inject(DestroyRef).onDestroy(() => this.meta.clear());
  }

  day(iso: string): string {
    return shortDate(iso);
  }

  summary(file: PublishedFile): string {
    return parameterSummary(this.report()?.parameters ?? [], file.params, shortDate);
  }

  setValues(values: FormValues): void {
    this.values.set(values);
    this.errors.set({});
  }

  openCreate(): void {
    this.errors.set({});
    void this.router.navigate([], { relativeTo: this.route, queryParams: { create: 'new', published: null }, queryParamsHandling: 'merge' });
  }

  closeCreate(): void {
    const cleared = Object.fromEntries((this.report()?.parameters ?? []).map((p) => [p.key, null]));
    void this.router.navigate([], { relativeTo: this.route, queryParams: { create: null, ...cleared }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Keeps the values in this address, so Back from the preview reopens the panel, then opens the preview. */
  async runPreview(): Promise<void> {
    const item = this.report();
    if (!item) return;
    const missing = missingParameters(item.parameters, this.values(), t('ui.reports.required'));
    if (Object.keys(missing).length) return this.errors.set(missing);
    const params = parameterQuery(parameterValues(item.parameters, this.values()));
    await this.router.navigate([], { relativeTo: this.route, queryParams: { create: 'new', ...params }, replaceUrl: true });
    await this.router.navigate(['/print/report', item.key], { queryParams: params });
  }

  preview(file: PublishedFile): void {
    void this.router.navigate(['/print/report', this.key()], { queryParams: { published: file.id } });
  }

  /** Excel downloads the kept workbook. A PDF opens its kept page with the print dialog, where it is saved as PDF. */
  async download(file: PublishedFile): Promise<void> {
    if (file.format === 'pdf') {
      void this.router.navigate(['/print/report', this.key()], { queryParams: { published: file.id, download: '1' } });
      return;
    }
    this.busy.set(true);
    this.downloadError.set('');
    try {
      const out = await this.files$.download('GET', `/api/reports/published/${encodeURIComponent(file.id)}/file`);
      if ('json' in out) return;
      const url = URL.createObjectURL(out.body);
      const link = document.createElement('a');
      link.href = url;
      link.download = out.fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      this.downloadError.set(e instanceof ApiError && e.message ? e.message : t('ui.reports.failed'));
    } finally {
      this.busy.set(false);
    }
  }

  private async load(key: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const out = await this.api.get<{ report: ReportView; published: PublishedFile[] }>(`/api/reports/${encodeURIComponent(key)}`);
      this.report.set(out.report);
      this.files.set(out.published);
      this.values.set(valuesFromQuery(out.report.parameters, (name) => this.route.snapshot.queryParamMap.get(name)));
      this.meta.crumbLabels.set({ report: out.report.label, ...(out.report.group ? { reportGroup: out.report.group.label } : {}) });
    } catch (e) {
      this.error.set(e instanceof ApiError && e.message ? e.message : t('ui.reports.notFound'));
    } finally {
      this.loading.set(false);
    }
  }
}
