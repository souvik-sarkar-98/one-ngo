import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { layoutDiagram } from '../../../core/builder/diagram';
import { httpEditor } from '../../../core/builder/http-editor';
import * as ops from '../../../core/builder/ops/workflow';
import { stateRows, stepRows, unreachableStates, workflowGraph } from '../../../core/builder/workflow-view';
import type { ApprovalDef, FieldDef, TransitionDef, WorkflowBody } from '../../../core/models';
import type { SuggestionSource } from '../../../core/ui-logic/autocomplete';
import { Api } from '../../../services/api';
import { I18n } from '../../../services/i18n';
import { BuilderStore } from '../../builder-store';
import { WorkflowSetStore } from './workflow-set-store';

const keysOf = (body: unknown, list: 'states' | 'transitions'): string[] => {
  const items = (body as Partial<WorkflowBody> | undefined)?.[list];
  return Array.isArray(items) ? items.map((i) => i.key) : [];
};

/**
 * One workflow on the Visual tab: applies every change to the draft through
 * the pure operations in `core/builder/ops/workflow`, keeps the selected step
 * in the address (`?step=`), and loads the record type's fields, the record
 * types and the roles the panels offer.
 */
@Injectable()
export class WorkflowEditorStore {
  private readonly builder = inject(BuilderStore);
  private readonly siblings = inject(WorkflowSetStore);
  private readonly i18n = inject(I18n);
  private readonly editor = httpEditor(inject(Api));

  readonly expressions = this.builder.expressions;
  readonly body = computed(() => this.builder.body() as unknown as WorkflowBody | null);
  readonly recordTypes = signal<string[]>([]);
  readonly fields = signal<FieldDef[]>([]);
  readonly roles = signal<{ key: string; label: string }[]>([]);
  readonly selectedState = signal<string | null>(null);
  readonly selectedStep = computed(() => this.builder.address().step ?? null);

  readonly stateIndex = computed(() => this.body()?.states.findIndex((s) => s.key === this.selectedState()) ?? -1);
  readonly stepIndex = computed(() => this.body()?.transitions.findIndex((s) => s.key === this.selectedStep()) ?? -1);
  readonly step = computed(() => this.body()?.transitions[this.stepIndex()] ?? null);
  /** Keys in the published version: records store state keys and permissions name step keys, so they stay. */
  private readonly published = computed(() => {
    const d = this.builder.state()?.detail;
    return d?.published?.body ?? d?.shipped?.base;
  });
  readonly fixedStates = computed(() => keysOf(this.published(), 'states'));
  readonly fixedSteps = computed(() => keysOf(this.published(), 'transitions'));
  /** Step keys of the record type's other workflows; step keys are unique across them. */
  readonly takenSteps = computed(() => {
    const key = this.body()?.key ?? '';
    return ops.otherStepKeys(this.siblings.set(), key);
  });

  readonly layout = computed(() => {
    this.i18n.locale();
    const b = this.body();
    if (!b) return layoutDiagram([], [], '');
    const g = workflowGraph(b);
    return layoutDiagram(g.nodes, g.edges, b.initial);
  });
  readonly stateRows = computed(() => (this.i18n.locale(), this.body() ? stateRows(this.body()!) : []));
  readonly stepRows = computed(() => (this.i18n.locale(), this.body() ? stepRows(this.body()!, this.fields()) : []));
  readonly unreachable = computed(() => (this.body() ? unreachableStates(this.body()!) : []));

  readonly permissionSource: SuggestionSource = {
    minLength: 0,
    search: async (q) => (await this.editor.permissionSuggestions(q)).map((s) => ({ id: s.permission, label: s.permission, hint: s.label })),
  };

  constructor() {
    this.builder.gateway
      .catalogue()
      .then((c) => this.recordTypes.set(c.filter((i) => i.kind === 'recordType').map((i) => i.key)))
      .catch(() => undefined);
    this.editor
      .roles()
      .then((r) => this.roles.set(r))
      .catch(() => undefined);
    const recordType = computed(() => this.body()?.recordType);
    effect(() => {
      const key = recordType();
      untracked(() => {
        if (!key) return this.fields.set([]);
        this.builder.gateway
          .publishedRecordType(key)
          .then((d) => this.fields.set(d.body.fields))
          .catch(() => this.fields.set([]));
      });
    });
  }

  private apply(fn: (b: WorkflowBody) => WorkflowBody): void {
    const b = this.body();
    if (b) this.builder.edit(fn(b) as unknown as Record<string, unknown>);
  }

  setRecordType(recordType: string): void {
    this.apply((b) => ({ ...b, recordType }));
  }

  setRole(role: ops.WorkflowRole): void {
    this.apply((b) => ops.setRole(b, role));
  }

  setCondition(source: string): void {
    this.apply((b) => ops.setCondition(b, source));
  }

  // ---------------------------------------------------------------- states

  selectState(key: string | null): void {
    this.selectedState.set(key);
  }

  addState(): void {
    this.apply((b) => ops.addState(b));
    this.selectedState.set(this.body()?.states.at(-1)?.key ?? null);
  }

  setStateLabel(index: number, label: string): void {
    this.apply((b) => ops.setStateLabel(b, index, label, this.fixedStates()));
    this.selectedState.set(this.body()?.states[index]?.key ?? null);
  }

  renameState(index: number, key: string): void {
    this.apply((b) => ops.renameState(b, index, key));
    this.selectedState.set(key);
  }

  setStateFlags(index: number, flags: { final?: boolean; locked?: boolean }): void {
    this.apply((b) => ops.setStateFlags(b, index, flags));
  }

  setInitial(key: string): void {
    this.apply((b) => ops.setInitial(b, key));
  }

  removeState(key: string): void {
    const index = this.body()?.states.findIndex((s) => s.key === key) ?? -1;
    if (index < 0) return;
    this.apply((b) => ops.removeState(b, index));
    if (this.selectedState() === key) this.selectedState.set(null);
  }

  moveState(from: number, to: number): void {
    this.apply((b) => ops.moveState(b, from, to));
  }

  // ---------------------------------------------------------------- steps

  selectStep(key: string | null): void {
    this.builder.select(key ? { step: key } : {});
  }

  addStep(): void {
    this.apply((b) => ops.addStep(b, this.takenSteps()));
    const key = this.body()?.transitions.at(-1)?.key;
    if (key) this.selectStep(key);
  }

  setStepLabel(index: number, label: string): void {
    this.apply((b) => ops.setStepLabel(b, index, label, this.takenSteps(), this.fixedSteps()));
    this.followStep(index);
  }

  setStepKey(index: number, key: string): void {
    this.apply((b) => ops.setStep(b, index, { key }));
    this.followStep(index);
  }

  setStep(index: number, patch: Partial<TransitionDef>): void {
    this.apply((b) => ops.setStep(b, index, patch));
  }

  toggleFrom(index: number, state: string, on: boolean): void {
    this.apply((b) => ops.toggleFrom(b, index, state, on));
  }

  toggleRequired(index: number, field: string, on: boolean): void {
    this.apply((b) => ops.toggleRequired(b, index, field, on));
  }

  toggleApproval(index: number, on: boolean): void {
    this.apply((b) => ops.toggleApproval(b, index, on));
  }

  setApproval(index: number, patch: Partial<ApprovalDef>): void {
    this.apply((b) => ops.setApproval(b, index, patch));
  }

  toggleApprover(index: number, role: string, on: boolean): void {
    const roles = (this.body()?.transitions[index]?.approval?.roles ?? []).filter((r) => r !== role);
    this.setApproval(index, { roles: on ? [...roles, role] : roles });
  }

  removeStep(key: string): void {
    const index = this.body()?.transitions.findIndex((s) => s.key === key) ?? -1;
    if (index < 0) return;
    this.apply((b) => ops.removeStep(b, index));
    if (this.selectedStep() === key) this.selectStep(null);
  }

  moveStep(from: number, to: number): void {
    this.apply((b) => ops.moveStep(b, from, to));
  }

  /** Keeps the step selected when its key follows its label. */
  private followStep(index: number): void {
    const key = this.body()?.transitions[index]?.key;
    if (key && key !== this.selectedStep()) this.builder.select({ step: key }, true);
  }
}
