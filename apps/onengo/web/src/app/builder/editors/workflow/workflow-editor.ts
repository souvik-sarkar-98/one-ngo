import { Component, computed, inject } from '@angular/core';
import { conditionOf, roleOf } from '../../../core/builder/ops/workflow';
import { edgeStep } from '../../../core/builder/workflow-view';
import { t } from '../../../core/i18n/i18n';
import { TranslatePipe } from '../../../services/i18n';
import { Diagram } from '../../../ui/diagram';
import { EditableTable } from '../../../ui/editable-table';
import { ExpressionField } from '../../../ui/expression-field';
import type { TableColumn } from '../../../ui/table-rows';
import { WorkflowStepPanel } from './step-panel';
import { WorkflowSetStore } from './workflow-set-store';
import { WorkflowEditorStore } from './workflow-store';
import { WorkflowsList } from './workflows-list';

/**
 * The Visual tab of a workflow (Builder 6, 7 and the workflows list): the
 * record type's workflows with this one's role and condition, its diagram,
 * and its states and steps, each opening a panel.
 */
@Component({
  selector: 'app-workflow-editor',
  imports: [TranslatePipe, Diagram, EditableTable, ExpressionField, WorkflowStepPanel, WorkflowsList],
  providers: [WorkflowSetStore, WorkflowEditorStore],
  styleUrl: './workflow.css',
  template: `
    @if (store.body(); as b) {
      <section class="wf-section">
        <app-workflows-list [recordType]="b.recordType" [current]="b">
          <div workflowPanel class="wf-panel">
            <div class="field">
              <label for="wf-type">{{ 'ui.builder.workflow.recordType' | t }}</label>
              <select id="wf-type" (change)="store.setRecordType(val($event))">
                @for (rt of recordTypes(); track rt) { <option [value]="rt" [selected]="rt === b.recordType">{{ rt }}</option> }
              </select>
            </div>
            <div class="field">
              <label for="wf-role">{{ 'ui.builder.schema.prop.role' | t }}</label>
              <select id="wf-role" (change)="store.setRole($any(val($event)))">
                <option value="primary" [selected]="!parallel()">{{ 'ui.builder.schema.enum.primary' | t }}</option>
                <option value="parallel" [selected]="parallel()">{{ 'ui.builder.schema.enum.parallel' | t }}</option>
              </select>
            </div>
            <app-expression-field
              [assist]="store.expressions"
              [recordType]="b.recordType"
              [label]="(parallel() ? 'ui.builder.schema.prop.startsWhen' : 'ui.builder.workflows.chosenWhen') | t"
              [hint]="(parallel() ? 'ui.builder.workflows.startsHint' : 'ui.builder.workflows.chosenHint') | t"
              [value]="condition()"
              (valueChange)="store.setCondition($event)" />
          </div>
        </app-workflows-list>
      </section>

      <section class="wf-section" aria-labelledby="wf-diagram-title">
        <h3 class="wf-title" id="wf-diagram-title">{{ 'ui.builder.workflows.diagram' | t }}</h3>
        <p class="help">{{ 'ui.builder.workflows.diagramHint' | t }}</p>
        <app-diagram
          [layout]="store.layout()"
          [selected]="store.selectedState()"
          [selectedEdge]="store.selectedStep()"
          (nodeSelect)="store.selectState($event)"
          (edgeSelect)="store.selectStep(edgeStep($event))" />
        @if (store.unreachable().length) {
          <div class="notice info" role="status">⚠ {{ 'ui.builder.workflows.unreachable' | t: { states: store.unreachable().join(', ') } }}</div>
        }
      </section>

      <section class="wf-section" aria-labelledby="wf-states-title">
        <h3 class="wf-title" id="wf-states-title">{{ 'ui.builder.workflows.statesCount' | t: { count: b.states.length } }}</h3>
        <app-editable-table
          [rows]="store.stateRows()"
          [columns]="stateColumns()"
          [selectedId]="store.selectedState()"
          [labels]="stateLabels()"
          (rowSelect)="store.selectState($event)"
          (moved)="store.moveState($event.from, $event.to)"
          (add)="store.addState()"
          (remove)="b.states.length > 1 && store.removeState($event)">
          @if (b.states[store.stateIndex()]; as s) {
            <div rowPanel class="wf-panel">
              <div class="field">
                <label for="wf-state-label">{{ 'ui.builder.label' | t }}</label>
                <input id="wf-state-label" [value]="s.label" (input)="store.setStateLabel(store.stateIndex(), val($event))" />
              </div>
              <div class="field">
                <label for="wf-state-key">{{ 'ui.builder.key' | t }}</label>
                <input id="wf-state-key" [value]="s.key" [disabled]="store.fixedStates().includes(s.key)" (change)="store.renameState(store.stateIndex(), val($event))" />
              </div>
              <label class="wf-check"><input type="radio" name="wf-initial" [checked]="s.key === b.initial" (change)="store.setInitial(s.key)" /> {{ 'ui.builder.schema.prop.initial' | t }}</label>
              <label class="wf-check"><input type="checkbox" [checked]="!!s.final" (change)="store.setStateFlags(store.stateIndex(), { final: chk($event) })" /> {{ 'ui.builder.workflow.final' | t }}</label>
              <label class="wf-check"><input type="checkbox" [checked]="!!s.locked" (change)="store.setStateFlags(store.stateIndex(), { locked: chk($event) })" /> {{ 'ui.builder.workflow.lockedForEditing' | t }}</label>
            </div>
          }
        </app-editable-table>
      </section>

      <section class="wf-section" aria-labelledby="wf-steps-title">
        <h3 class="wf-title" id="wf-steps-title">{{ 'ui.builder.workflows.stepsCount' | t: { count: b.transitions.length } }}</h3>
        <app-editable-table
          [rows]="store.stepRows()"
          [columns]="stepColumns()"
          badgeKey="approval"
          [selectedId]="store.selectedStep()"
          [labels]="stepLabels()"
          (rowSelect)="store.selectStep($event)"
          (moved)="store.moveStep($event.from, $event.to)"
          (add)="store.addStep()"
          (remove)="store.removeStep($event)">
          @if (store.step(); as s) {
            <app-workflow-step-panel rowPanel [step]="s" [index]="store.stepIndex()" />
          }
        </app-editable-table>
      </section>
    } @else {
      <p class="muted">{{ 'ui.common.loading' | t }}</p>
    }
  `,
})
export class WorkflowEditor {
  readonly store = inject(WorkflowEditorStore);
  readonly edgeStep = edgeStep;

  readonly parallel = computed(() => roleOf(this.store.body() ?? {}) === 'parallel');
  readonly condition = computed(() => (this.store.body() ? conditionOf(this.store.body()!) : ''));
  /** The published record types, plus the workflow's own when it is not (yet) among them. */
  readonly recordTypes = computed(() => {
    const own = this.store.body()?.recordType;
    const all = this.store.recordTypes();
    return own && !all.includes(own) ? [own, ...all] : all;
  });
  readonly stateColumns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.label') },
    { key: 'start', label: t('ui.builder.workflows.startColumn') },
    { key: 'final', label: t('ui.builder.workflow.final') },
    { key: 'locked', label: t('ui.builder.workflow.locked') },
  ]);
  readonly stepColumns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.workflow.buttonLabel') },
    { key: 'move', label: t('ui.builder.workflows.fromTo') },
    { key: 'asks', label: t('ui.builder.workflows.asksFor') },
    { key: 'who', label: t('ui.builder.workflows.who') },
    { key: 'approval', label: t('ui.builder.schema.prop.approval') },
  ]);
  readonly stateLabels = computed(() => ({ add: t('ui.builder.workflow.addStatus') }));
  readonly stepLabels = computed(() => ({ add: t('ui.builder.workflow.addStep') }));

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  chk(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }
}
