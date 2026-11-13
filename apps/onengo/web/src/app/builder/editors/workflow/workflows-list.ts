import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import type { WorkflowRole } from '../../../core/builder/ops/workflow';
import { t } from '../../../core/i18n/i18n';
import type { WorkflowBody } from '../../../core/models';
import { TranslatePipe } from '../../../services/i18n';
import { EditableTable } from '../../../ui/editable-table';
import type { TableColumn } from '../../../ui/table-rows';
import { WorkflowSetStore } from './workflow-set-store';

/**
 * A record type's workflows: role, condition and size of each, adding one,
 * the "Applies to" summary and the rules across them. Choosing another
 * workflow opens it; the open one shows the content projected with the
 * `workflowPanel` attribute. The host provides the WorkflowSetStore.
 */
@Component({
  selector: 'app-workflows-list',
  imports: [TranslatePipe, EditableTable],
  styleUrl: './workflow.css',
  template: `
    <h3 class="wf-title">{{ 'ui.builder.workflows.title' | t: { count: store.set().length } }}</h3>
    @if (store.failed()) { <div class="notice error" role="alert">{{ 'ui.builder.workflows.loadFailed' | t }}</div> }
    <app-editable-table
      [rows]="store.rows()"
      [columns]="columns()"
      badgeKey="role"
      [selectedId]="panelOpen() ? (current()?.key ?? null) : null"
      [reorderable]="false"
      [removable]="false"
      [labels]="tableLabels()"
      (rowSelect)="choose($event)"
      (add)="store.startAdding()">
      <div rowPanel><ng-content select="[workflowPanel]" /></div>
    </app-editable-table>

    @if (store.adding()) {
      <form class="wf-add" (submit)="$event.preventDefault(); store.add(name.value, role())">
        <div class="field">
          <label for="wf-add-name">{{ 'ui.builder.name' | t }}</label>
          <input #name id="wf-add-name" [disabled]="store.busy()" />
        </div>
        <div class="field">
          <label for="wf-add-role">{{ 'ui.builder.schema.prop.role' | t }}</label>
          <select id="wf-add-role" [value]="role()" (change)="role.set($any($event.target).value)">
            <option value="primary">{{ 'ui.builder.schema.enum.primary' | t }}</option>
            <option value="parallel">{{ 'ui.builder.schema.enum.parallel' | t }}</option>
          </select>
        </div>
        <button type="submit" class="primary" [disabled]="store.busy()">{{ 'ui.common.add' | t }}</button>
        <button type="button" (click)="store.cancelAdding()">{{ 'ui.common.cancel' | t }}</button>
        @if (store.addError()) { <div class="notice error wf-add__error" role="alert">{{ store.addError() }}</div> }
      </form>
    }

    <div class="wf-applies">
      <div>
        <h4 class="wf-panel__title">{{ 'ui.builder.workflows.appliesTo' | t }}</h4>
        <ul class="wf-summary">
          @for (line of store.summary(); track $index) { <li>{{ line }}</li> }
        </ul>
      </div>
      <ul class="wf-issues">
        @for (c of store.checks(); track $index) {
          <li [class]="'wf-issue wf-issue--' + c.level">{{ c.level === 'ok' ? '✓' : '⚠' }} {{ c.message }}</li>
        }
      </ul>
    </div>
  `,
})
export class WorkflowsList {
  readonly store = inject(WorkflowSetStore);
  readonly recordType = input.required<string>();
  /** The workflow open in the editor; its draft stands in for its saved version. */
  readonly current = input<WorkflowBody | null>(null);
  readonly panelOpen = signal(true);
  readonly role = signal<WorkflowRole>('primary');

  readonly columns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.kind.workflow') },
    { key: 'role', label: t('ui.builder.schema.prop.role') },
    { key: 'condition', label: t('ui.builder.workflows.condition') },
    { key: 'states', label: t('ui.builder.schema.prop.states') },
    { key: 'steps', label: t('ui.builder.schema.prop.transitions') },
  ]);
  readonly tableLabels = computed(() => ({ add: t('ui.builder.workflows.add') }));

  constructor() {
    effect(() => {
      const recordType = this.recordType();
      const current = this.current();
      untracked(() => {
        this.store.recordType.set(recordType);
        this.store.current.set(current);
      });
    });
  }

  choose(key: string | null): void {
    if (key === null || key === this.current()?.key) this.panelOpen.set(key !== null);
    else this.store.open(key);
  }
}
