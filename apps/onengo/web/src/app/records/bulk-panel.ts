import { Component, computed, inject } from '@angular/core';
import { t } from '../core/i18n/i18n';
import { minutesLeft } from '../core/records/import/import-session';
import { summaryLine } from '../core/records/bulk/selection';
import { TranslatePipe } from '../services/i18n';
import { CfForm } from '../ui/cf-form';
import { MobileFormSheet } from '../ui/form-panel';
import { BulkStore } from './bulk-store';
import { ListStore } from './list-store';

/**
 * The bulk panel: the operation's fields asked once for every selected
 * record, a large run's progress, then the result summary with the records
 * that failed. It has no address of its own, as the selection has none.
 */
@Component({
  selector: 'app-bulk-panel',
  imports: [MobileFormSheet, CfForm, TranslatePipe],
  styles: `
    .bulk-panel__error {
      margin: 0 0 12px;
      font-size: 0.75rem;
      color: #b91c1c;
    }
    .bulk-panel__muted {
      font-size: 0.72rem;
      color: var(--secondary-500);
    }
    .bulk-panel__bar {
      height: 8px;
      margin: 8px 0 12px;
      border-radius: 999px;
      background: #e2e8f0;
      overflow: hidden;
    }
    .bulk-panel__bar > i {
      display: block;
      height: 100%;
      background: var(--primary-500);
      transition: width 0.3s;
    }
    .bulk-panel__banner {
      margin: 0 0 12px;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 0.8rem;
      background: #dcfce7;
    }
    .bulk-panel__problems {
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 0.75rem;
    }
    .bulk-panel__problems li {
      padding: 6px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.15);
    }
  `,
  template: `
    @let s = bulk.snapshot();
    @if (s) {
      <app-mobile-form-sheet
        [open]="bulk.open()"
        [title]="title()"
        [hint]="hint()"
        [saving]="s.busy"
        [saveLabel]="'ui.bulk.apply' | t: { count: s.count }"
        [showDefaultFooter]="!!s.op && !s.job && !s.summary"
        (dismissed)="bulk.close()"
        (save)="bulk.submit()">
        @for (g of s.general; track $index) {
          <p class="bulk-panel__error" role="alert">{{ g }}</p>
        }
        @if (s.error) {
          <p class="bulk-panel__error" role="alert">{{ s.error }}</p>
        }
        @if (s.summary; as r) {
          <p class="bulk-panel__banner" role="status">{{ line() }}</p>
          @if (r.stopped) {
            <p class="bulk-panel__muted">{{ 'ui.bulk.stopped' | t }}</p>
          }
          <ul class="bulk-panel__problems">
            @for (p of r.problems; track p.id) {
              <li><b>{{ p.record }}</b> · {{ p.message }}</li>
            }
          </ul>
        } @else if (s.job; as job) {
          <div>
            <b>{{ 'ui.imports.progress' | t: { done: job.progress, total: job.total ?? s.count } }}</b>
            @if (left(); as m) {
              <span class="bulk-panel__muted"> · {{ 'ui.imports.minutesLeft' | t: { count: m } }}</span>
            }
          </div>
          <div class="bulk-panel__bar" role="progressbar" [attr.aria-valuenow]="job.progress" aria-valuemin="0" [attr.aria-valuemax]="job.total ?? s.count">
            <i [style.width.%]="percent()"></i>
          </div>
          <p class="bulk-panel__muted">{{ 'ui.bulk.keepWorking' | t }}</p>
        } @else if (s.op) {
          <cf-form [fields]="bulk.formFields()" [values]="s.values" [errors]="s.errors" idPrefix="bulk" (valuesChange)="bulk.setValues($event)"></cf-form>
        }

        @if (s.summary || s.error) {
          <button sheetFooterActions type="button" class="app-btn app-btn--primary" (click)="bulk.close()">{{ 'ui.imports.done' | t }}</button>
        } @else if (s.job) {
          <ng-container sheetFooterActions>
            <button type="button" class="app-btn app-btn--ghost" (click)="bulk.close()">{{ 'ui.common.close' | t }}</button>
            <button type="button" class="app-btn danger" [disabled]="s.job.cancelRequested" (click)="bulk.stop()">{{ 'ui.bulk.stop' | t }}</button>
          </ng-container>
        }
      </app-mobile-form-sheet>
    }
  `,
})
export class BulkPanel {
  readonly bulk = inject(BulkStore);
  private readonly list = inject(ListStore);

  readonly title = computed(() => {
    const s = this.bulk.snapshot();
    return s?.op && !s.summary && !s.job ? t('ui.bulk.title', { operation: s.label, count: s.count }) : (s?.label ?? '');
  });
  readonly hint = computed(() => {
    const op = this.bulk.snapshot()?.op;
    const s = this.bulk.snapshot();
    if (!op || s?.job || s?.summary) return undefined;
    if (op.kind === 'edit') return t('ui.bulk.editHint');
    if (op.kind === 'action') return this.list.spec()?.actions.find((a) => a.key === op.key)?.confirm ?? t('ui.bulk.checks');
    return op.kind === 'step' ? t('ui.bulk.checks') : undefined;
  });
  readonly line = computed(() => {
    const r = this.bulk.snapshot()?.summary;
    return r ? summaryLine(r) : '';
  });
  readonly percent = computed(() => {
    const job = this.bulk.snapshot()?.job;
    return job?.total ? Math.round((job.progress / job.total) * 100) : 0;
  });
  readonly left = computed(() => {
    const job = this.bulk.snapshot()?.job;
    return job ? minutesLeft(job, Date.now()) : null;
  });
}
