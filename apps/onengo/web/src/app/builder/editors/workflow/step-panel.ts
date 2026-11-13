import { Component, computed, inject, input } from '@angular/core';
import { stepPermission } from '../../../core/builder/workflow-view';
import type { TransitionDef } from '../../../core/models';
import { TranslatePipe } from '../../../services/i18n';
import { ExpressionField } from '../../../ui/expression-field';
import { PermissionField } from '../../../ui/permission-field';
import { WorkflowEditorStore } from './workflow-store';

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** One step: where it goes, what it asks for, when it is allowed, who may run it, and whether it needs approval. */
@Component({
  selector: 'app-workflow-step-panel',
  imports: [TranslatePipe, ExpressionField, PermissionField],
  template: `
    @let s = step();
    @let b = store.body()!;
    @let i = index();
    <div class="wf-panel">
      <h4 class="wf-panel__title">{{ 'ui.builder.workflows.movement' | t }}</h4>
      <div class="field">
        <label for="wf-step-label">{{ 'ui.builder.workflow.buttonLabel' | t }}</label>
        <input id="wf-step-label" [value]="s.label" (input)="store.setStepLabel(i, val($event))" />
      </div>
      <div class="field">
        <label for="wf-step-key">{{ 'ui.builder.key' | t }}</label>
        <input id="wf-step-key" [value]="s.key" [disabled]="fixed()" (change)="store.setStepKey(i, val($event))" />
      </div>
      <fieldset class="wf-checks">
        <legend>{{ 'ui.builder.workflow.availableFrom' | t }}</legend>
        @for (st of b.states; track st.key) {
          <label><input type="checkbox" [checked]="s.from.includes(st.key)" (change)="store.toggleFrom(i, st.key, chk($event))" /> {{ st.label || st.key }}</label>
        }
      </fieldset>
      <div class="field">
        <label for="wf-step-to">{{ 'ui.builder.workflow.movesTo' | t }}</label>
        <select id="wf-step-to" [value]="s.to" (change)="store.setStep(i, { to: val($event) })">
          @for (st of b.states; track st.key) { <option [value]="st.key" [selected]="st.key === s.to">{{ st.label || st.key }}</option> }
        </select>
      </div>
      @if (store.fields().length) {
        <fieldset class="wf-checks">
          <legend>{{ 'ui.builder.workflow.fieldsToFill' | t }}</legend>
          @for (f of store.fields(); track f.key) {
            <label><input type="checkbox" [checked]="(s.requiredFields ?? []).includes(f.key)" (change)="store.toggleRequired(i, f.key, chk($event))" /> {{ f.label }}</label>
          }
        </fieldset>
      }

      <h4 class="wf-panel__title">{{ 'ui.builder.schema.prop.guard' | t }}</h4>
      <app-expression-field
        [assist]="store.expressions"
        [recordType]="b.recordType"
        [label]="'ui.builder.workflow.onlyAllowedWhen' | t"
        [placeholder]="'ui.builder.workflow.guardPlaceholder' | t"
        [value]="s.guard ?? ''"
        (valueChange)="store.setStep(i, { guard: $event || undefined })" />
      <div class="field">
        <label for="wf-step-message">{{ 'ui.builder.workflow.guardMessage' | t }}</label>
        <input id="wf-step-message" [value]="s.guardMessage ?? ''" (input)="store.setStep(i, { guardMessage: val($event) || undefined })" />
      </div>

      <h4 class="wf-panel__title">{{ 'ui.builder.workflows.whoCanRun' | t }}</h4>
      <app-permission-field
        [label]="'ui.builder.schema.prop.permission' | t"
        [hint]="'ui.builder.workflows.permissionHint' | t: { permission: defaultPermission() }"
        [value]="s.permission ?? ''"
        [source]="store.permissionSource"
        (valueChange)="store.setStep(i, { permission: $event || undefined })" />

      <h4 class="wf-panel__title">{{ 'ui.builder.schema.prop.approval' | t }}</h4>
      <label class="wf-check"><input type="checkbox" [checked]="!!s.approval" (change)="store.toggleApproval(i, chk($event))" /> {{ 'ui.builder.workflow.needsApproval' | t }}</label>
      @if (s.approval; as a) {
        @if (roleChoices().length) {
          <fieldset class="wf-checks">
            <legend>{{ 'ui.builder.workflow.approverRoles' | t }}</legend>
            @for (r of roleChoices(); track r.key) {
              <label><input type="checkbox" [checked]="(a.roles ?? []).includes(r.key)" (change)="store.toggleApprover(i, r.key, chk($event))" /> {{ r.label }}</label>
            }
          </fieldset>
        } @else {
          <div class="field">
            <label for="wf-step-roles">{{ 'ui.builder.workflow.approverRoles' | t }}</label>
            <input id="wf-step-roles" [placeholder]="'ui.builder.workflow.rolesPlaceholder' | t" [value]="(a.roles ?? []).join(', ')" (change)="store.setApproval(i, { roles: list(val($event)) })" />
          </div>
        }
        <div class="field">
          <label for="wf-step-users">{{ 'ui.builder.schema.prop.users' | t }}</label>
          <input id="wf-step-users" [value]="(a.users ?? []).join(', ')" (change)="store.setApproval(i, { users: list(val($event)) })" />
        </div>
        <div class="field">
          <label for="wf-step-count">{{ 'ui.builder.workflow.approvalsNeeded' | t }}</label>
          <input id="wf-step-count" type="number" min="1" max="5" [value]="a.count ?? 1" (input)="store.setApproval(i, { count: count(val($event)) })" />
        </div>
        <app-expression-field
          [assist]="store.expressions"
          [recordType]="b.recordType"
          [label]="'ui.builder.schema.prop.when' | t"
          [hint]="'ui.builder.workflows.whenHint' | t"
          [placeholder]="'ui.builder.workflow.approvalWhenPlaceholder' | t"
          [value]="a.when ?? ''"
          (valueChange)="store.setApproval(i, { when: $event })" />
        <p class="help">{{ 'ui.builder.workflows.notOwn' | t }}</p>
      }
    </div>
  `,
})
export class WorkflowStepPanel {
  readonly store = inject(WorkflowEditorStore);
  readonly step = input.required<TransitionDef>();
  readonly index = input.required<number>();
  readonly list = list;

  readonly fixed = computed(() => this.store.fixedSteps().includes(this.step().key));
  readonly defaultPermission = computed(() => stepPermission(this.store.body()?.recordType ?? '', this.step().key));
  /** The organisation's roles, plus any the step names that are not among them. */
  readonly roleChoices = computed(() => {
    const roles = this.store.roles();
    if (!roles.length) return [];
    const extra = (this.step().approval?.roles ?? []).filter((r) => !roles.some((x) => x.key === r)).map((key) => ({ key, label: key }));
    return [...roles.map((r) => ({ key: r.key, label: r.label || r.key })), ...extra];
  });

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  chk(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  count(v: string): number {
    return Math.min(5, Math.max(1, Math.round(+v) || 1));
  }
}
