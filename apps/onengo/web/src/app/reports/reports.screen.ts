import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon, PageFrame } from '@onengo/web-kit';
import { CollapsedGroups } from '../core/groups';
import { t } from '../core/i18n/i18n';
import { reportSections, type RunnableReport } from './report-groups';
import type { ReportFormat } from './report-files';
import { Api, ApiError } from '../services/api';
import { TranslatePipe } from '../services/i18n';
import { Session } from '../services/session';
import { ScreenHeading } from '../ui/screen-heading';

interface ReportListItem extends RunnableReport {
  format: ReportFormat;
}

/** Reports the signed-in person may run, grouped like Records. Each row names the report's one format. */
@Component({
  selector: 'app-reports-screen',
  imports: [PageFrame, ScreenHeading, TranslatePipe, RouterLink, Icon],
  styles: `
    :host { display: block; }
    .groups__heading { margin: 0; font-size: inherit; }
    .sec-head, .list-row { --icon-size: 18px; }
    .sec-head { --icon-size: 20px; }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.nav.reports' | t" />
      @if (error()) {
        <div class="notice error" role="alert">{{ error() }}</div>
      } @else if (loading()) {
        <p class="muted">{{ 'ui.common.loading' | t }}</p>
      } @else if (!reports().length) {
        <p class="muted">{{ 'ui.reports.empty' | t }}</p>
      } @else {
        @for (section of sections(); track section.key) {
          <section>
            <h2 class="groups__heading">
              <button type="button" class="sec-head" [attr.aria-expanded]="!section.collapsed" [attr.aria-controls]="'report-group-' + section.key" (click)="toggle(section.key)">
                <span>{{ section.label }}</span>
                <app-icon [name]="section.collapsed ? 'down' : 'up'" />
              </button>
            </h2>
            @if (!section.collapsed) {
              <ul class="panel list-rows" [id]="'report-group-' + section.key">
                @for (report of section.reports; track report.key) {
                  <li>
                    <a class="list-row" [routerLink]="report.link">
                      <span class="list-row__text">
                        <strong>{{ report.label }}</strong>
                        <span class="list-row__sub">{{ formatLabel(report.key) | t }}</span>
                      </span>
                      <app-icon name="next" />
                    </a>
                  </li>
                }
              </ul>
            }
          </section>
        }
      }
    </app-page-frame>
  `,
})
export class ReportsScreen {
  private readonly api = inject(Api);
  private readonly memory = new CollapsedGroups(localStorage, inject(Session).me()?.tenant.key ?? '', 'reports');
  readonly reports = signal<ReportListItem[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  private readonly collapsed = signal(this.memory.value);
  readonly sections = computed(() => reportSections(this.reports(), this.collapsed(), t('ui.reports.otherGroup')));

  constructor() {
    void this.load();
  }

  toggle(group: string): void {
    this.collapsed.set(this.memory.toggle(group));
  }

  formatLabel(key: string): string {
    return this.reports().find((r) => r.key === key)?.format === 'excel' ? 'ui.reports.formatExcel' : 'ui.reports.formatPdf';
  }

  private async load(): Promise<void> {
    try {
      const out = await this.api.get<{ reports: ReportListItem[] }>('/api/reports');
      this.reports.set(out.reports);
    } catch (e) {
      this.error.set(e instanceof ApiError && e.message ? e.message : t('ui.reports.loadFailed'));
    } finally {
      this.loading.set(false);
    }
  }
}
