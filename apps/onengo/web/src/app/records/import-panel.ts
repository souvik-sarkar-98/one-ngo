import { Component, computed, inject, signal } from '@angular/core';
import { formatNumber, t } from '../core/i18n/i18n';
import { IMPORT_STEPS, RESULT_STEP, RUN_STEP, importableFields, mappingRows, minutesLeft, updateByFields } from '../core/records/import/import-session';
import type { FormValues } from '../core/records/record/forms';
import { TranslatePipe } from '../services/i18n';
import { CfForm } from '../ui/cf-form';
import type { CfFieldDef } from '../ui/cf-types';
import { EditableTable } from '../ui/editable-table';
import { MobileFormSheet } from '../ui/form-panel';
import { ImportStore } from './import-store';
import { ListStore } from './list-store';

const field = (key: string, label: string, type: CfFieldDef['type'], extra: Partial<CfFieldDef> = {}): CfFieldDef => ({
  key,
  label,
  type,
  required: false,
  readOnly: false,
  options: [],
  ...extra,
});

/**
 * The import stepper in the record panel: upload, match columns, check, run
 * with the job's progress, and the result. Which import and step are open
 * comes from the address; every step goes through the import store.
 */
@Component({
  selector: 'app-import-panel',
  imports: [MobileFormSheet, EditableTable, CfForm, TranslatePipe],
  styles: `
    .import-panel__head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 12px;
      font-size: 0.85rem;
      color: var(--secondary-900);
    }
    .import-panel__muted {
      font-size: 0.72rem;
      color: var(--secondary-500);
    }
    .import-panel__error {
      margin: 0 0 12px;
      font-size: 0.75rem;
      color: #b91c1c;
    }
    .import-panel__drop {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 24px 12px;
      border: 2px dashed rgba(148, 163, 184, 0.6);
      border-radius: 12px;
      text-align: center;
      font-size: 0.85rem;
      cursor: pointer;
    }
    .import-panel__drop--over,
    .import-panel__drop:focus-within {
      border-color: var(--primary-500);
      background: var(--primary-100);
    }
    .import-panel__input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
    }
    .import-panel__file {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin: 12px 0;
      padding: 8px 12px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 10px;
      font-size: 0.8rem;
    }
    .import-panel__link {
      padding: 0;
      border: 0;
      background: none;
      font: inherit;
      font-size: 0.75rem;
      color: var(--primary-700);
      text-decoration: underline;
      cursor: pointer;
    }
    .import-panel__counts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }
    .import-panel__count {
      padding: 8px 12px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 10px;
      font-size: 0.72rem;
      color: var(--secondary-700);
    }
    .import-panel__count b {
      display: block;
      font-size: 1rem;
      color: var(--secondary-900);
    }
    .import-panel__problems {
      margin: 0 0 12px;
      padding: 0;
      list-style: none;
      font-size: 0.75rem;
    }
    .import-panel__problems li {
      padding: 6px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.15);
      color: #b91c1c;
    }
    .import-panel__bar {
      height: 8px;
      margin: 8px 0 12px;
      border-radius: 999px;
      background: #e2e8f0;
      overflow: hidden;
    }
    .import-panel__bar > i {
      display: block;
      height: 100%;
      background: var(--primary-500);
      transition: width 0.3s;
    }
    .import-panel__banner {
      margin: 0 0 12px;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 0.8rem;
      background: #dcfce7;
      color: #15803d;
    }
    .import-panel__banner--warning {
      background: #fef3c7;
      color: #b45309;
    }
    .import-panel__block {
      width: 100%;
      margin-bottom: 6px;
    }
  `,
  template: `
    @if (snap(); as s) {
      <app-mobile-form-sheet [open]="true" [title]="title()" [saving]="s.busy" [showDefaultFooter]="false" (dismissed)="io.imports.close()">
        <div class="import-panel__head">
          <b>{{ stepLabels[s.step] | t }}</b>
          <span class="import-panel__muted">{{ 'ui.imports.stepOf' | t: { step: s.step + 1, steps: stepLabels.length } }}</span>
        </div>
        @if (s.error) {
          <p class="import-panel__error" role="alert">{{ s.error }}</p>
        }
        @if (s.loading) {
          <p class="import-panel__muted" role="status">{{ 'ui.common.loading' | t }}</p>
        } @else {
          @switch (s.step) {
            @case (0) {
              <label class="import-panel__drop" [class.import-panel__drop--over]="over()" (dragover)="dragOver($event)" (dragleave)="over.set(false)" (drop)="drop($event)">
                <input type="file" accept=".csv,text/csv" class="import-panel__input" (change)="picked($event)" />
                @if (store.narrow()) {
                  <span class="app-btn app-btn--secondary">{{ 'ui.imports.chooseCsv' | t }}</span>
                } @else {
                  <span>{{ 'ui.imports.dropHere' | t }}</span>
                }
                <span class="import-panel__muted">{{ 'ui.imports.limits' | t }}</span>
              </label>
              @if (s.file; as f) {
                <div class="import-panel__file">
                  <b>{{ f.name }}</b>
                  <span class="import-panel__muted">{{ 'ui.imports.fileSize' | t: { size: kb(f.size) } }}</span>
                </div>
              }
              <p class="import-panel__muted">
                <button type="button" class="import-panel__link" (click)="io.downloadSample()">{{ 'ui.imports.sample' | t }}</button>
              </p>
            }
            @case (1) {
              <app-editable-table
                [rows]="mapRows()"
                [columns]="mapColumns()"
                [selectedId]="selected()"
                badgeKey="field"
                [reorderable]="false"
                [addable]="false"
                [removable]="false"
                (rowSelect)="selected.set($event)">
                @if (selected(); as column) {
                  <div rowPanel>
                    <cf-form [fields]="[fieldPicker()]" [values]="{ field: s.columns[column] ?? '' }" idPrefix="import-column" (valuesChange)="setColumn(column, $event)"></cf-form>
                  </div>
                }
              </app-editable-table>
              @if (updateForm().length) {
                <cf-form [fields]="updateForm()" [values]="updateValues()" idPrefix="import-update" (valuesChange)="setUpdate($event)"></cf-form>
              }
            }
            @case (2) {
              @if (s.check; as c) {
                <div class="import-panel__counts">
                  <div class="import-panel__count"><b>{{ n(c.rows) }}</b>{{ 'ui.imports.rowsInFile' | t }}</div>
                  <div class="import-panel__count"><b>{{ n(c.creates) }}</b>{{ 'ui.imports.willCreate' | t }}</div>
                  <div class="import-panel__count"><b>{{ n(c.updates) }}</b>{{ 'ui.imports.willUpdate' | t }}</div>
                  <div class="import-panel__count"><b>{{ n(c.invalid) }}</b>{{ 'ui.imports.haveProblems' | t }}</div>
                </div>
                @if (c.problems.length) {
                  <ul class="import-panel__problems" [attr.aria-label]="'ui.imports.haveProblems' | t">
                    @for (p of c.problems; track $index) {
                      <li>{{ 'ui.imports.problem' | t: { row: p.row, message: p.message } }}</li>
                    }
                  </ul>
                  @if (c.invalid > c.problems.length) {
                    <p class="import-panel__muted">{{ 'ui.imports.firstProblems' | t: { shown: c.problems.length } }}</p>
                  }
                }
                @if (io.canQuiet()) {
                  <cf-form [fields]="[automationsField()]" [values]="{ automations: !s.quiet }" idPrefix="import-quiet" (valuesChange)="io.imports.setQuiet($event['automations'] !== true)"></cf-form>
                }
              }
            }
            @case (3) {
              @let job = s.job;
              <div class="import-panel__head">
                <b>{{ 'ui.imports.progress' | t: { done: job?.progress ?? 0, total: job?.total ?? s.view?.rowCount ?? 0 } }}</b>
                @if (left(); as m) {
                  <span class="import-panel__muted">{{ 'ui.imports.minutesLeft' | t: { count: m } }}</span>
                }
              </div>
              <div class="import-panel__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="percent()">
                <i [style.width.%]="percent()"></i>
              </div>
              <p class="import-panel__muted">{{ (job?.cancelRequested ? 'ui.imports.cancelling' : 'ui.imports.keepWorking') | t }}</p>
            }
            @case (4) {
              @let counts = s.view?.counts ?? { created: 0, updated: 0, failed: 0 };
              @if (s.view?.status === 'done') {
                <p class="import-panel__banner" role="status">{{ 'ui.imports.finished' | t: counts }}</p>
              } @else {
                <p class="import-panel__banner import-panel__banner--warning" role="status">{{ s.job?.error ?? ('ui.imports.stopped' | t) }}</p>
              }
              <div class="import-panel__counts">
                <div class="import-panel__count"><b>{{ n(counts.created) }}</b>{{ 'ui.imports.created' | t }}</div>
                <div class="import-panel__count"><b>{{ n(counts.updated) }}</b>{{ 'ui.imports.updated' | t }}</div>
                <div class="import-panel__count"><b>{{ n(counts.failed) }}</b>{{ 'ui.imports.failed' | t }}</div>
              </div>
              @if (counts.failed) {
                <button type="button" class="app-btn app-btn--secondary import-panel__block" (click)="io.downloadFailed()">{{ 'ui.imports.downloadFailed' | t }}</button>
                <p class="import-panel__muted">{{ 'ui.imports.failedHint' | t }}</p>
              }
            }
          }
        }

        @if (s.step === 0 || s.step === 1 || s.step === 2) {
          <button sheetFooterActions type="button" class="app-btn app-btn--ghost" [disabled]="s.busy" (click)="s.step === 0 ? io.imports.close() : io.imports.back()">
            {{ (s.step === 0 ? 'ui.common.cancel' : 'ui.common.back') | t }}
          </button>
        }
        @if (s.step === 0) {
          <button sheetFooterActions type="button" class="app-btn app-btn--primary" [disabled]="s.busy || !s.file" (click)="io.imports.upload()">
            {{ 'ui.common.next' | t }}
          </button>
        }
        @if (s.step === 1) {
          <button sheetFooterActions type="button" class="app-btn app-btn--primary" [disabled]="s.busy || s.loading" (click)="io.imports.checkRows()">
            {{ 'ui.common.next' | t }}
          </button>
        }
        @if (s.step === 2) {
          <button sheetFooterActions type="button" class="app-btn app-btn--primary" [disabled]="s.busy || !s.check?.valid" (click)="io.imports.run()">
            {{ 'ui.imports.run' | t: { count: s.check?.valid ?? 0 } }}
          </button>
        }
        @if (s.step === runStep) {
          <button sheetFooterActions type="button" class="app-btn app-btn--ghost" (click)="io.imports.close()">{{ 'ui.common.close' | t }}</button>
        }
        @if (s.step === runStep) {
          <button sheetFooterActions type="button" class="app-btn danger" [disabled]="s.busy || !!s.job?.cancelRequested" (click)="io.imports.cancel()">
            {{ 'ui.imports.cancel' | t }}
          </button>
        }
        @if (s.step === resultStep) {
          <button sheetFooterActions type="button" class="app-btn app-btn--primary" (click)="io.imports.close()">{{ 'ui.imports.done' | t }}</button>
        }
      </app-mobile-form-sheet>
    }
  `,
})
export class ImportPanel {
  readonly store = inject(ListStore);
  readonly io = inject(ImportStore);
  readonly stepLabels = IMPORT_STEPS;
  readonly runStep = RUN_STEP;
  readonly resultStep = RESULT_STEP;
  readonly over = signal(false);
  readonly selected = signal<string | null>(null);

  /** The session's snapshot while the address has an import open. */
  readonly snap = computed(() => (this.store.state()?.import ? this.io.snapshot() : null));
  private readonly type = computed(() => this.store.spec()!.type);
  readonly title = computed(() => t('ui.imports.title', { type: this.store.spec()!.title.toLowerCase() }));
  readonly mapRows = computed(() => {
    const s = this.snap();
    return s ? mappingRows(this.type(), s.view, s.columns) : [];
  });
  readonly mapColumns = computed(() => [
    { key: 'title', label: t('ui.imports.column') },
    ...(this.store.narrow() ? [] : [{ key: 'samples', label: t('ui.imports.samples') }]),
    { key: 'field', label: t('ui.imports.field') },
  ]);
  readonly fieldPicker = computed(() =>
    field('field', t('ui.imports.field'), 'select', {
      options: [{ key: '', label: t('ui.imports.notImported') }, ...importableFields(this.type()).map((f) => ({ key: f.key, label: f.label }))],
    }),
  );
  private readonly uniques = computed(() => updateByFields(this.type(), this.snap()?.columns ?? {}));
  readonly updateForm = computed<CfFieldDef[]>(() => {
    const u = this.uniques();
    const type = this.type().label.toLowerCase();
    if (u.length === 1) {
      return [field('updateBy', t('ui.imports.updateWhen', { type, field: u[0]!.label }), 'boolean', { hint: t('ui.imports.updateHint', { type }) })];
    }
    if (!u.length) return [];
    const options = [{ key: '', label: t('ui.imports.createAll') }, ...u.map((f) => ({ key: f.key, label: f.label }))];
    return [field('updateBy', t('ui.imports.updateBy', { type }), 'select', { options, hint: t('ui.imports.updateHint', { type }) })];
  });
  readonly updateValues = computed<FormValues>(() => {
    const by = this.snap()?.updateBy ?? null;
    return { updateBy: this.uniques().length === 1 ? !!by : (by ?? '') };
  });
  readonly automationsField = computed(() =>
    field('automations', t('ui.imports.automations', { type: this.store.spec()!.title.toLowerCase() }), 'boolean', { hint: t('ui.imports.automationsHint') }),
  );
  readonly percent = computed(() => {
    const job = this.snap()?.job;
    return job?.total ? Math.round((job.progress / job.total) * 100) : 0;
  });
  readonly left = computed(() => {
    const job = this.snap()?.job;
    return job ? minutesLeft(job, Date.now()) : null;
  });

  n(value: number): string {
    return formatNumber(value);
  }

  kb(bytes: number): string {
    return formatNumber(Math.max(1, Math.round(bytes / 1024)));
  }

  picked(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.io.imports.choose(file, file.name);
    input.value = '';
  }

  dragOver(e: DragEvent): void {
    e.preventDefault();
    this.over.set(true);
  }

  drop(e: DragEvent): void {
    e.preventDefault();
    this.over.set(false);
    const file = e.dataTransfer?.files[0];
    if (file) this.io.imports.choose(file, file.name);
  }

  setColumn(column: string, values: FormValues): void {
    const v = values['field'];
    this.io.imports.setColumn(column, typeof v === 'string' && v ? v : null);
  }

  setUpdate(values: FormValues): void {
    const v = values['updateBy'];
    const u = this.uniques();
    this.io.imports.setUpdateBy(v === true ? u[0]!.key : typeof v === 'string' && v ? v : null);
  }
}
