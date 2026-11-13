import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { FormLayout, RuntimeAction } from '../core/models';
import { actionNeedsPanel, footerGroups, panelActions, showsConfirmation } from '../core/records/record/actions';
import type { FieldModel, FormValues } from '../core/records/record/forms';
import { approvalSummary, detailSections, editSummary, recordTitle, stepSummary, workflowLines } from '../core/records/record/present';
import { relatedSectionId, type RelatedCreate } from '../core/records/record/related';
import { canShare } from '../core/records/sharing/sharing';
import { Api } from '../services/api';
import { TranslatePipe } from '../services/i18n';
import { CfForm } from '../ui/cf-form';
import { cfField, type CfFieldDef } from '../ui/cf-types';
import { dialogCloseLabel } from '../ui/dialog';
import { ListCreateSheet, ListCreateStepperSheet, MobileFormSheet } from '../ui/form-panel';
import { ListDetailSheet } from '../ui/panel';
import { RowMenu } from '../ui/row-menu';
import { ListStore } from './list-store';
import { RecordStore } from './record-store';
import { RecordShare } from './share-panel';

/**
 * The record panel on ui/panel, one column on every size: a bottom sheet on
 * phones, centred up to 720px otherwise. Its mode comes from the address:
 * view (one status line per workflow, pending approval, sections; footer with
 * the steps grouped by workflow, the configured actions, then Edit), edit, a
 * workflow step, a configured action (its form and confirmation), or create.
 */
@Component({
  selector: 'app-record-panel',
  imports: [ListDetailSheet, ListCreateSheet, ListCreateStepperSheet, MobileFormSheet, CfForm, RowMenu, RecordShare, TranslatePipe],
  styleUrl: '../ui/styles/na-list-dashboard.css',
  styles: `
    .record-panel__workflows {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .record-panel__workflow {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--secondary-700);
    }
    .record-panel__badge {
      flex-shrink: 0;
      font-size: 0.58rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      border-radius: 999px;
      padding: 4px 8px;
      line-height: 1;
      background: #f1f5f9;
      color: #475569;
    }
    .record-panel__badge[data-tone='success'] {
      background: #dcfce7;
      color: #15803d;
    }
    .record-panel__badge[data-tone='warning'] {
      background: #fef3c7;
      color: #b45309;
    }
    .record-panel__badge[data-tone='primary'] {
      background: var(--primary-100);
      color: var(--primary-700);
    }
    .record-panel__group-label {
      font-size: 0.62rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--secondary-500);
    }
    .record-panel__summary {
      margin-bottom: 12px;
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 12px;
      background: #fffaf5;
    }
    .record-panel__summary-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 8px;
      padding: 8px 12px;
      font-size: 0.72rem;
    }
    .record-panel__summary-row:not(:last-child) {
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
    }
    .record-panel__summary-label {
      font-weight: 600;
      color: var(--secondary-700);
    }
    .record-panel__confirm {
      margin: 0 0 12px;
      font-size: 0.85rem;
      line-height: 1.5;
      color: var(--secondary-900);
    }
  `,
  template: `
    @if (store.spec(); as spec) {
      @let state = store.state()!;
      @let r = rec.snapshot();
      @if (r) {
        <app-list-detail-sheet
          [open]="!!r.record && !state.create && !step() && !action() && !sharing()"
          [mode]="state.panel.kind === 'edit' && actions()?.edit ? 'edit' : 'view'"
          [title]="r.record ? recordTitle(spec, r.record) : ('ui.common.details' | t)"
          [sections]="sections()"
          [loading]="r.loading"
          [saving]="r.busy"
          [primaryActionLabel]="actions()?.edit ? ('ui.common.edit' | t) : undefined"
          [hasFooterActions]="!!groups().length || !!configured().length || !!creates().length"
          [editSummary]="r.record ? editSummary(spec, r.record) : []"
          [editFields]="formFields()"
          [editColumns]="layout().columns"
          [editFullWidth]="layout().fullWidth"
          [editValues]="r.values"
          [editErrors]="r.errors"
          [editError]="r.error"
          [editProblems]="r.general"
          [notice]="notice()"
          [viewError]="state.panel.kind === 'view' && r.record ? r.error : ''"
          (closed)="store.intents.close()"
          (primaryAction)="store.intents.setPanel({ kind: 'edit' })"
          (editCancel)="store.intents.setPanel({ kind: 'view' })"
          (editSave)="rec.session.save(models())"
          (editValuesChange)="setValues($event)"
          (itemSelect)="selectItem($event)">
          @if (recordMenu().length && state.panel.kind === 'view') {
            <app-row-menu detailHeaderActions [actions]="recordMenu()" (choose)="store.intents.setPanel({ kind: 'share' })" />
          }
          @if (lines().length) {
            <div detailHero class="record-panel__workflows" role="list" [attr.aria-label]="'ui.records.workflows' | t">
              @for (l of lines(); track l.workflow) {
                <div class="record-panel__workflow" role="listitem">
                  <span>{{ l.name }}</span>
                  <span class="record-panel__badge" [attr.data-tone]="l.tone">{{ l.state }}</span>
                </div>
              }
            </div>
          }
          @if (publicLink(); as path) {
            <div detailViewExtras>
              <article class="list-detail-sections__item">
                <div>{{ 'ui.public.link' | t }}</div>
                <a [href]="path">{{ path }}</a>
                @if (canRevokePublicLink()) {
                  <div class="app-btn-group">
                    <button type="button" class="app-btn" [disabled]="r.busy" (click)="revokePublicLink()">{{ 'ui.public.revoke' | t }}</button>
                  </div>
                }
              </article>
            </div>
          }
          @if (r.pending; as p) {
            <div detailViewExtras>
              <article class="list-detail-sections__item" role="status">
                <div>{{ approvalSummary(spec, p) }}</div>
                @if (p.canDecide) {
                  <div class="app-btn-group">
                    <button type="button" class="app-btn app-btn--primary" [disabled]="r.busy" (click)="rec.session.decide('approve')">{{ 'ui.common.approve' | t }}</button>
                    <button type="button" class="app-btn" [disabled]="r.busy" (click)="rec.session.decide('reject')">{{ 'ui.common.reject' | t }}</button>
                  </div>
                }
              </article>
            </div>
          }
          @if (groups().length || configured().length || creates().length) {
            <div detailFooterActions class="list-dashboard__detail-footer-actions">
              @for (c of creates(); track c.id) {
                <button type="button" class="app-btn app-btn--primary" [disabled]="r.busy" (click)="createRelated(c)">{{ c.label }}</button>
              }
              @for (g of groups(); track g.workflow) {
                @if (g.label) {
                  <div class="record-panel__group-label">{{ g.label }}</div>
                }
                @for (s of g.steps; track s.key) {
                  <button
                    type="button"
                    class="app-btn"
                    [class.app-btn--primary]="s.primary"
                    [class.app-btn--secondary]="!s.primary"
                    [disabled]="!!r.pending || r.busy"
                    (click)="store.intents.setPanel({ kind: 'step', step: s.key })">
                    {{ s.label }}
                  </button>
                }
              }
              @for (a of configured(); track a.key) {
                <button type="button" class="app-btn app-btn--secondary" [disabled]="r.busy" (click)="start(a)">
                  {{ a.label }}
                </button>
              }
            </div>
          }
        </app-list-detail-sheet>

        @if (sharing()) {
          <app-record-share />
        }

        @if (step(); as s) {
          <app-list-create-sheet
            [open]="true"
            [title]="s.label"
            [saveLabel]="s.label"
            [saving]="r.busy"
            [fields]="formFields()"
            [values]="r.values"
            [errors]="r.errors"
            [error]="r.error"
            [problems]="r.general"
            idPrefix="list-action-form"
            (valuesChange)="setValues($event)"
            (dismissed)="store.intents.setPanel({ kind: 'view' })"
            (saved)="rec.session.step(s, models())">
            @if (r.record) {
              <div listCreatePrefix class="record-panel__summary">
                @for (row of stepSummary(spec, r.record, s.key); track row.label) {
                  <div class="record-panel__summary-row">
                    <span class="record-panel__summary-label">{{ row.label }}</span>
                    <span>{{ row.value }}</span>
                  </div>
                }
              </div>
            }
          </app-list-create-sheet>
        }

        @if (action(); as a) {
          @let confirm = showsConfirmation(a, r.confirming);
          <app-mobile-form-sheet [open]="true" [title]="a.label" [error]="r.error" [problems]="r.general" [saving]="r.busy" [showDefaultFooter]="false" (dismissed)="store.intents.setPanel({ kind: 'view' })">
            @if (confirm) {
              <p class="record-panel__confirm">{{ a.confirm }}</p>
            } @else {
              @if (r.record) {
                <div class="record-panel__summary">
                  @for (row of editSummary(spec, r.record); track row.label) {
                    <div class="record-panel__summary-row">
                      <span class="record-panel__summary-label">{{ row.label }}</span>
                      <span>{{ row.value }}</span>
                    </div>
                  }
                </div>
              }
              <cf-form [fields]="formFields()" [values]="r.values" [errors]="r.errors" idPrefix="record-action-form" [columns]="layout().columns" [fullWidth]="layout().fullWidth" (valuesChange)="setValues($event)"></cf-form>
            }
            <button sheetFooterActions type="button" class="app-btn app-btn--ghost" [disabled]="r.busy" (click)="cancelAction(a)">
              {{ r.confirming && a.form?.fields?.length ? ('ui.common.back' | t) : dialogCloseLabel(a.label, ('ui.common.cancel' | t)) }}
            </button>
            <button sheetFooterActions type="button" class="app-btn app-btn--primary" [disabled]="r.busy" (click)="rec.session.act(a, models())">
              {{ r.busy ? ('ui.common.submitting' | t) : a.label }}
            </button>
          </app-mobile-form-sheet>
        }

        @if (state.create) {
          @if (spec.createSteps.length) {
            <app-list-create-stepper-sheet
              [open]="true"
              [title]="'ui.records.createTitle' | t: { type: spec.type.label.toLocaleLowerCase() }"
              [saving]="r.busy"
              [stepLabel]="spec.createSteps[state.createStep]!.label"
              [stepIndex]="state.createStep"
              [columns]="layout().columns"
              [fullWidth]="layout().fullWidth"
              [stepCount]="spec.createSteps.length"
              [fields]="formFields()"
              [values]="r.values"
              [errors]="r.errors"
              [error]="r.error"
              [problems]="r.general"
              (valuesChange)="setValues($event)"
              (dismissed)="store.intents.closeCreate()"
              (back)="createBack()"
              (next)="createNext()">
            </app-list-create-stepper-sheet>
          } @else {
            <app-list-create-sheet
              [open]="true"
              [title]="'ui.records.createTitle' | t: { type: spec.type.label.toLocaleLowerCase() }"
              [saving]="r.busy"
              [fields]="formFields()"
              [values]="r.values"
              [errors]="r.errors"
              [error]="r.error"
              [problems]="r.general"
              [columns]="layout().columns"
              [fullWidth]="layout().fullWidth"
              (valuesChange)="setValues($event)"
              (dismissed)="store.intents.closeCreate()"
              (saved)="createNext()">
            </app-list-create-sheet>
          }
        }
      }
    }
  `,
})
export class RecordPanel {
  readonly store = inject(ListStore);
  readonly rec = inject(RecordStore);
  private readonly api = inject(Api);
  readonly publicLink = signal<string | null>(null);
  /** Revoking changes the record's link, so it needs the same permission as editing the record. */
  readonly canRevokePublicLink = computed(() => !!this.store.spec()?.type.canUpdate);
  readonly recordTitle = recordTitle;
  readonly editSummary = editSummary;
  readonly approvalSummary = approvalSummary;
  readonly stepSummary = stepSummary;
  readonly showsConfirmation = showsConfirmation;
  readonly dialogCloseLabel = dialogCloseLabel;

  private readonly chip = computed(() => this.store.state()?.chip);
  readonly actions = computed(() => (this.rec.snapshot() ? this.rec.session.actions(this.chip()) : null));
  private readonly recordActions = computed(() => (this.rec.snapshot() ? this.rec.session.recordActions(this.chip()) : null));
  readonly groups = computed(() => {
    const a = this.recordActions();
    return a ? footerGroups(this.store.spec()!, a) : [];
  });
  readonly configured = computed(() => {
    const a = this.recordActions();
    return a ? panelActions(a) : [];
  });
  readonly step = computed(() => (this.rec.snapshot() ? this.rec.session.currentStep(this.chip()) : null));
  readonly action = computed(() => (this.rec.snapshot() ? this.rec.session.currentAction(this.chip()) : null));
  readonly lines = computed(() => {
    const r = this.rec.snapshot()?.record;
    return r ? workflowLines(this.store.spec()!, r) : [];
  });
  readonly sections = computed(() => {
    const r = this.rec.snapshot();
    return r?.record ? [...detailSections(this.store.spec()!, r.record, r.receipts, this.store.viewer()), ...this.rec.session.relatedSections()] : [];
  });
  readonly creates = computed(() => (this.rec.snapshot()?.record ? this.rec.session.relatedCreates() : []));
  /** The panel's ⋮: record-level options that are not steps or actions; in this release, Share. */
  readonly recordMenu = computed(() => (canShare(this.store.spec()!, this.rec.snapshot()?.record) ? [{ id: 'share', label: t('ui.share.action') }] : []));
  readonly sharing = computed(() => this.store.state()?.panel.kind === 'share' && this.recordMenu().length > 0);
  /** The fields of whichever form is open: edit, the running step or action, or the create step. */
  readonly models = computed<FieldModel[]>(() => (this.rec.snapshot() ? this.rec.session.fields() : []));
  /** The wide-screen layout of whichever form is open; phones draw one column regardless. */
  readonly layout = computed<FormLayout>(() => (this.rec.snapshot() ? this.rec.session.formLayout() : { columns: 1, fullWidth: [] }));
  readonly formFields = computed(() =>
    this.models().map((m): CfFieldDef => {
      const p = this.rec.session.picker(m);
      const session = this.rec.session;
      return p ? { ...cfField(m), picker: { ...p, choose: (o) => void session.choose(m.key, o), clear: () => void session.choose(m.key, null) } } : cfField(m);
    }),
  );

  /** What just happened to the open record ("Your changes have been saved."), shown in its sheet for a few seconds. */
  readonly notice = signal('');
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.noticeTimer));
    const saidMessage = computed(() => this.rec.snapshot()?.message ?? '');
    effect(() => {
      const message = saidMessage();
      untracked(() => {
        clearTimeout(this.noticeTimer);
        this.notice.set(message);
        if (message) this.noticeTimer = setTimeout(() => this.notice.set(''), 5000);
      });
    });
    effect(() => {
      const id = this.rec.snapshot()?.record?.id;
      const type = this.store.spec()?.type.key;
      untracked(() => void this.loadPublicLink(type, id));
    });
    effect(() => {
      const done = this.rec.completed();
      if (!done) return;
      untracked(() => {
        if (done.created) {
          this.store.intents.closeCreate();
          void this.store.intents.controller.reload();
        } else if (done.open) void this.store.follow(done.open);
        else if (this.store.state()?.panel.kind !== 'view') this.store.intents.setPanel({ kind: 'view' });
      });
    });
  }

  async revokePublicLink(): Promise<void> {
    const id = this.rec.snapshot()?.record?.id;
    const type = this.store.spec()?.type.key;
    if (!id || !type) return;
    await this.api.delete(`/api/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}/public-link`);
    this.publicLink.set(null);
  }

  private async loadPublicLink(type: string | undefined, id: string | undefined): Promise<void> {
    if (!type || !id) {
      this.publicLink.set(null);
      return;
    }
    try {
      const link = await this.api.get<{ path: string }>(`/api/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}/public-link`);
      if (this.rec.snapshot()?.record?.id === id) this.publicLink.set(link.path);
    } catch {
      if (this.rec.snapshot()?.record?.id === id) this.publicLink.set(null);
    }
  }

  setValues(values: FormValues): void {
    this.rec.session.setValues(values);
  }

  /** A footer action: actions with a form or a confirmation open in the panel, the others run at once. */
  start(action: RuntimeAction): void {
    if (actionNeedsPanel(action)) this.store.intents.setPanel({ kind: 'action', action: action.key });
    else void this.rec.session.act(action, []);
  }

  cancelAction(action: RuntimeAction): void {
    if (this.rec.snapshot()?.confirming && action.form?.fields.length) this.rec.session.backToForm();
    else this.store.intents.setPanel({ kind: 'view' });
  }

  selectItem(e: { section: string; item: string }): void {
    if (e.section === 'receipts') return this.store.printReceipt(e.item);
    const related = this.rec.snapshot()?.related.find((s) => relatedSectionId(s) === e.section);
    if (related) this.store.openList(related.recordType, { id: e.item });
  }

  createRelated(c: RelatedCreate): void {
    this.store.openList(c.recordType, { create: 'new', ...c.presets });
  }

  createBack(): void {
    const s = this.store.state()!;
    if (s.createStep === 0) this.store.intents.closeCreate();
    else this.store.intents.setCreateStep(s.createStep - 1);
  }

  createNext(): void {
    const spec = this.store.spec()!;
    const s = this.store.state()!;
    if (spec.createSteps.length && s.createStep < spec.createSteps.length - 1) {
      if (this.rec.session.check(this.models())) this.store.intents.setCreateStep(s.createStep + 1);
    } else void this.rec.session.create(this.models());
  }
}
