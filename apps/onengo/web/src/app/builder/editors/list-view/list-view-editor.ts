import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { createSummary, fieldLabel } from '../../../core/builder/list-view-view';
import * as ops from '../../../core/builder/ops/list-view';
import { t } from '../../../core/i18n/i18n';
import type { FieldDef, FormColumns, ListLayout, ListViewDef, ListViewSection } from '../../../core/models';
import { TranslatePipe } from '../../../services/i18n';
import { ChipFilterBar } from '../../../ui/chip-bar';
import { EditableTable } from '../../../ui/editable-table';
import { MobileFormSheet } from '../../../ui/form-panel';
import { LivePreview } from '../../../ui/live-preview';
import { PermissionField } from '../../../ui/permission-field';
import type { TableColumn } from '../../../ui/table-rows';
import { FieldPills, type FieldDrop, type FieldOption } from './field-pills';
import { ListViewEditorStore } from './list-view-store';

type Edit = (b: ListViewDef) => ListViewDef;
type RowPart = 'title' | 'meta' | 'badge';
const SHOWS: ops.ChipShows[] = ['all', 'statuses', 'workflowState', 'mine', 'shared', 'field'];
const SHOWS_LABEL: Record<ops.ChipShows, string> = {
  all: 'ui.records.all',
  statuses: 'ui.builder.schema.prop.statusIn',
  workflowState: 'ui.builder.schema.prop.workflowState',
  mine: 'ui.builder.schema.enum.me',
  shared: 'ui.builder.schema.prop.shared',
  field: 'ui.builder.listView.showsField',
};

/**
 * The Visual tab of a list view (Builder 8–10 and 26): chips, filters, card
 * rows, table and tablet columns, record panel sections (fields or related
 * records, each with "Shown to people with"), the create form as one page or
 * steps, the edit form, index warnings, and a live preview of the draft.
 */
@Component({
  selector: 'app-list-view-editor',
  imports: [NgTemplateOutlet, TranslatePipe, ChipFilterBar, EditableTable, MobileFormSheet, LivePreview, PermissionField, FieldPills],
  providers: [ListViewEditorStore],
  styleUrl: './list-view.css',
  template: `
    @if (store.body(); as b) {
      <div class="lv">
        <div class="lv-main">
          <section class="lv-section lv-grid">
            <div class="field">
              <label for="lv-type">{{ 'ui.builder.schema.prop.recordType' | t }}</label>
              <select id="lv-type" (change)="store.setRecordType(val($event))">
                @for (rt of recordTypes(); track rt.key) { <option [value]="rt.key" [selected]="rt.key === b.recordType">{{ rt.label }}</option> }
              </select>
            </div>
            <div class="field">
              <label for="lv-label">{{ 'ui.builder.schema.prop.label' | t }}</label>
              <input id="lv-label" [value]="b.label ?? ''" (input)="edit(ops.setLabel, val($event))" />
            </div>
          </section>

          <section class="lv-section" aria-labelledby="lv-chips">
            <h3 class="lv-title" id="lv-chips">{{ 'ui.builder.listView.chipsCount' | t: { count: b.chips?.length ?? 0 } }}</h3>
            <app-editable-table
              [rows]="store.chipRows()"
              [columns]="chipColumns()"
              [selectedId]="store.selectedChip()"
              [addable]="(b.chips?.length ?? 0) < limits.chips"
              [labels]="{ add: ('ui.builder.listView.addChip' | t) }"
              (rowSelect)="store.selectChip($event)"
              (moved)="edit(ops.moveChip, $event.from, $event.to)"
              (add)="store.addChip()"
              (remove)="store.removeChip($event)">
              @if (chip(); as c) {
                <div rowPanel class="lv-panel">
                  @let i = store.chipIndex();
                  <div class="field">
                    <label for="lv-chip-label">{{ 'ui.builder.label' | t }}</label>
                    <input id="lv-chip-label" [value]="c.label" (input)="store.setChipLabel(i, val($event))" />
                    <span class="help">{{ 'ui.builder.keyHint' | t: { key: c.id } }}</span>
                  </div>
                  <div class="field">
                    <label for="lv-chip-shows">{{ 'ui.builder.listView.shows' | t }}</label>
                    <select id="lv-chip-shows" (change)="setShows(i, val($event))">
                      @for (s of shows; track s) { <option [value]="s" [selected]="s === chipShows(c)">{{ showsLabel[s] | t }}</option> }
                    </select>
                  </div>
                  @if (chipShows(c) === 'statuses') {
                    <fieldset class="lv-checks">
                      <legend>{{ 'ui.builder.schema.prop.statusIn' | t }}</legend>
                      @for (s of primaryStates(); track s.key) {
                        <label><input type="checkbox" [checked]="!!c.statusIn?.includes(s.key)" (change)="edit(ops.toggleChipStatus, i, s.key, chk($event))" /> {{ s.label }}</label>
                      }
                    </fieldset>
                  }
                  @if (chipShows(c) === 'field') {
                    <fieldset class="lv-conditions">
                      <legend>{{ 'ui.builder.listView.recordsWhere' | t }}</legend>
                      @for (entry of conditionEntries(c); track entry.field) {
                        <div class="lv-condition">
                          <div class="lv-condition__head">
                            <span>{{ fieldDef(entry.field)?.label ?? entry.field }}</span>
                            <button type="button" class="small" (click)="edit(ops.removeChipCondition, i, entry.field)">{{ 'ui.common.remove' | t }}</button>
                          </div>
                        @if (fieldDef(entry.field); as f) {
                            @if (ops.conditionKind(f) === 'choice') {
                              <div class="lv-checks">
                                @for (o of f.choices ?? []; track o.value) {
                                  <label><input type="checkbox" [checked]="ops.chipValues(entry.filter).includes(o.value)" (change)="edit(ops.toggleChipValue, i, f.key, o.value, chk($event))" /> {{ o.label }}</label>
                                }
                              </div>
                            } @else if (ops.conditionKind(f) === 'boolean') {
                              <select [id]="'lv-chip-flag-' + f.key" (change)="setFlag(i, f.key, val($event))">
                                <option value="" [selected]="entry.filter.eq === undefined"></option>
                                <option value="true" [selected]="entry.filter.eq === true">{{ 'ui.common.yes' | t }}</option>
                                <option value="false" [selected]="entry.filter.eq === false">{{ 'ui.common.no' | t }}</option>
                              </select>
                            } @else if (ops.conditionKind(f) === 'range') {
                              <div class="lv-add">
                                <label>{{ 'ui.builder.listView.from' | t }}
                                  <input [type]="f.type === 'date' ? 'date' : 'number'" [value]="entry.filter.from ?? ''" (change)="setBound(i, f, 'from', val($event))" />
                                </label>
                                <label>{{ 'ui.builder.listView.upTo' | t }}
                                  <input [type]="f.type === 'date' ? 'date' : 'number'" [value]="entry.filter.to ?? ''" (change)="setBound(i, f, 'to', val($event))" />
                                </label>
                              </div>
                            } @else {
                              @if (f.type === 'person') {
                                <label class="lv-check">
                                  <input type="checkbox" [checked]="entry.filter.eq === 'me'" (change)="edit(ops.setChipEquals, i, f.key, chk($event) ? 'me' : null)" />
                                  {{ 'ui.builder.listView.signedIn' | t }}
                                </label>
                              }
                              @if (f.type !== 'person' || entry.filter.eq !== 'me') {
                                <input [id]="'lv-chip-value-' + f.key" [value]="entry.filter.eq ?? ''" (change)="edit(ops.setChipEquals, i, f.key, val($event))" />
                              }
                            }
                        }
                        </div>
                      }
                      @if (unusedFields(c).length) {
                        <div class="field">
                          <label for="lv-chip-add-field">{{ 'ui.builder.listView.addCondition' | t }}</label>
                          <select id="lv-chip-add-field" (change)="addCondition(i, $event)">
                            <option value=""></option>
                            @for (f of unusedFields(c); track f.key) { <option [value]="f.key">{{ f.label }}</option> }
                          </select>
                        </div>
                      }
                    </fieldset>
                  }
                  @if (c.workflowState; as ws) {
                    <div class="field">
                      <label for="lv-chip-wf">{{ 'ui.builder.schema.prop.workflow' | t }}</label>
                      <select id="lv-chip-wf" (change)="edit(ops.setChipWorkflow, i, val($event))">
                        @if (!ws.workflow) { <option value="" selected></option> }
                        @for (w of store.workflows(); track w.key) { <option [value]="w.key" [selected]="w.key === ws.workflow">{{ w.key }}</option> }
                      </select>
                    </div>
                    <fieldset class="lv-checks">
                      <legend>{{ 'ui.builder.schema.prop.in' | t }}</legend>
                      @for (s of statesOf(ws.workflow); track s.key) {
                        <label><input type="checkbox" [checked]="ws.in.includes(s.key)" (change)="edit(ops.toggleChipState, i, s.key, chk($event))" /> {{ s.label }}</label>
                      }
                    </fieldset>
                  }
                  <app-permission-field
                    [label]="'ui.builder.listView.onlyFor' | t"
                    [hint]="'ui.builder.listView.onlyForHint' | t"
                    [value]="c.permission ?? ''"
                    [source]="store.permissionSource"
                    (valueChange)="edit(ops.setChipPermission, i, $event)" />
                  <label class="lv-check">
                    <input type="checkbox" [checked]="(b.defaultChip ?? b.chips?.[0]?.id) === c.id" (change)="edit(ops.setDefaultChip, chk($event) ? c.id : null)" />
                    {{ 'ui.builder.schema.prop.defaultChip' | t }}
                  </label>
                </div>
              }
            </app-editable-table>
          </section>

          <div class="lv-cols">
            <section class="lv-section">
              <h3 class="lv-title">{{ 'ui.builder.schema.prop.filters' | t }}</h3>
              <app-field-pills id="filters" [label]="'ui.builder.schema.prop.filters' | t" [keys]="b.filters ?? []" [options]="filterOptions()" (changed)="edit(ops.setFieldList, 'filters', $event)" />

              <h3 class="lv-title">{{ 'ui.builder.listView.rows' | t }}</h3>
              <ng-container *ngTemplateOutlet="rowSelect; context: { $implicit: 'title' }" />
              <div class="field">
                <span class="lv-label">{{ 'ui.builder.schema.prop.subtitle' | t }}</span>
                <app-field-pills id="subtitle" [label]="'ui.builder.schema.prop.subtitle' | t" [keys]="b.row?.subtitle ?? []" [options]="showable()" (changed)="edit(ops.setRow, { subtitle: $event })" />
              </div>
              <ng-container *ngTemplateOutlet="rowSelect; context: { $implicit: 'meta' }" />
              <ng-container *ngTemplateOutlet="rowSelect; context: { $implicit: 'badge' }" />
              <ng-template #rowSelect let-part>
                <div class="field">
                  <label [for]="'lv-row-' + part">{{ 'ui.builder.schema.prop.' + part | t }}</label>
                  <select [id]="'lv-row-' + part" (change)="setRowPart(part, val($event))">
                    <option value="" [selected]="!rowValue(part)">{{ 'ui.builder.listView.automatic' | t }}</option>
                    @for (o of showable(); track o.key) { <option [value]="o.key" [selected]="o.key === rowValue(part)">{{ o.label }}</option> }
                  </select>
                </div>
              </ng-template>
            </section>

            <section class="lv-section">
              <h3 class="lv-title">{{ 'ui.builder.schema.enum.table' | t }}</h3>
              <span class="lv-label">{{ 'ui.builder.schema.prop.columns' | t }}</span>
              <app-field-pills id="columns" [label]="'ui.builder.schema.prop.columns' | t" [keys]="b.columns ?? []" [options]="showable()" [max]="limits.columns" (changed)="edit(ops.setFieldList, 'columns', $event)" />
              <span class="lv-label">{{ 'ui.builder.schema.prop.compactColumns' | t }}</span>
              <app-field-pills id="compactColumns" [label]="'ui.builder.schema.prop.compactColumns' | t" [keys]="b.compactColumns ?? []" [options]="showable()" [max]="limits.compactColumns" (changed)="edit(ops.setFieldList, 'compactColumns', $event)" />
              <div class="lv-grid">
                <div class="field">
                  <label for="lv-layout">{{ 'ui.builder.schema.prop.layout' | t }}</label>
                  <select id="lv-layout" (change)="edit(ops.setLayout, layoutOf(val($event)))">
                    <option value="" [selected]="!b.layout">{{ 'ui.builder.listView.automatic' | t }}</option>
                    <option value="table" [selected]="b.layout === 'table'">{{ 'ui.builder.schema.enum.table' | t }}</option>
                    <option value="cards" [selected]="b.layout === 'cards'">{{ 'ui.builder.schema.enum.cards' | t }}</option>
                  </select>
                </div>
                <div class="field">
                  <label for="lv-size">{{ 'ui.builder.schema.prop.pageSize' | t }}</label>
                  <input id="lv-size" type="number" min="5" max="100" [value]="b.pageSize ?? ''" (change)="edit(ops.setPageSize, num($event))" />
                </div>
              </div>
            </section>
          </div>

          @for (n of store.indexNotices(); track $index) {
            <div class="notice info" role="status">⚠ {{ n }}</div>
          }

          <section class="lv-section" aria-labelledby="lv-sections">
            <h3 class="lv-title" id="lv-sections">{{ 'ui.builder.listView.sectionsCount' | t: { count: b.detail?.sections?.length ?? 0 } }}</h3>
            <app-editable-table
              [rows]="store.sectionRows()"
              [columns]="sectionColumns()"
              badgeKey="kind"
              [selectedId]="store.selectedSection()"
              [labels]="{ add: ('ui.builder.listView.addSection' | t) }"
              (rowSelect)="store.selectSection($event)"
              (moved)="edit(ops.moveSection, $event.from, $event.to)"
              (add)="store.addSection()"
              (remove)="store.removeSection($event)">
              @if (section(); as s) {
                <div rowPanel class="lv-panel">
                  @let i = store.sectionIndex();
                  <app-chip-filter-bar [chips]="sectionKinds()" [activeId]="related(s) ? 'related' : 'fields'" (chipSelect)="edit(ops.setSectionKind, i, $any($event))" />
                  <div class="field">
                    <label for="lv-section-label">{{ 'ui.builder.label' | t }}</label>
                    <input id="lv-section-label" [value]="s.label" (input)="edit(ops.setSectionLabel, i, val($event))" />
                  </div>
                  @if (related(s); as r) {
                    <div class="field">
                      <label for="lv-rel-type">{{ 'ui.builder.schema.prop.recordType' | t }}</label>
                      <select id="lv-rel-type" (change)="edit(ops.setRelated, i, { recordType: val($event) })">
                        @if (!r.related.recordType) { <option value="" selected></option> }
                        @for (o of relatedTypes(); track o.key) { <option [value]="o.key" [selected]="o.key === r.related.recordType">{{ o.label }}</option> }
                      </select>
                    </div>
                    <div class="field">
                      <label for="lv-rel-field">{{ 'ui.builder.listView.linkedThrough' | t }}</label>
                      <select id="lv-rel-field" (change)="edit(ops.setRelated, i, { field: val($event) })">
                        <option value="" [selected]="!r.related.field"></option>
                        @for (o of linksFrom(r.related.recordType); track o.field) { <option [value]="o.field" [selected]="o.field === r.related.field">{{ o.fieldLabel }}</option> }
                      </select>
                    </div>
                    <div class="field">
                      <label for="lv-rel-total">{{ 'ui.builder.listView.addUp' | t }}</label>
                      <select id="lv-rel-total" (change)="edit(ops.setRelated, i, { total: val($event) })">
                        <option value="" [selected]="!r.related.total"></option>
                        @for (f of totalsOf(r.related.recordType); track f.key) { <option [value]="f.key" [selected]="f.key === r.related.total">{{ f.label }}</option> }
                      </select>
                    </div>
                    @if (store.relatedOffer(r.related.recordType, r.related.field); as o) {
                      <p class="help">{{ (o.offered ? 'ui.builder.listView.offered' : 'ui.builder.listView.notOffered') | t: { list: o.list, field: o.field } }}</p>
                    }
                  } @else if (fieldsOf(s); as fs) {
                    <span class="lv-label">{{ 'ui.builder.schema.prop.fields' | t }}</span>
                    <app-field-pills id="section-fields" [label]="'ui.builder.schema.prop.fields' | t" [keys]="fs" [options]="showable()" (changed)="edit(ops.setSectionFields, i, $event)" />
                  }
                  <app-permission-field
                    [label]="'ui.builder.listView.shownTo' | t"
                    [hint]="'ui.builder.listView.shownToHint' | t"
                    [value]="s.permission ?? ''"
                    [source]="store.permissionSource"
                    (valueChange)="edit(ops.setSectionPermission, i, $event)" />
                </div>
              }
            </app-editable-table>
          </section>

          <div class="lv-cols">
            <section class="lv-section">
              <h3 class="lv-title">{{ 'ui.builder.schema.prop.create' | t }}</h3>
              <div class="lv-summary">
                <span>{{ createText() }}</span>
                <button type="button" class="small" (click)="store.openCreate(true)">{{ 'ui.common.edit' | t }}</button>
              </div>
              <ng-container *ngTemplateOutlet="requiredNotice" />
              <fieldset class="lv-checks">
                <legend>{{ 'ui.builder.listView.offeredOn' | t }}</legend>
                @for (c of b.chips ?? []; track c.id) {
                  <label><input type="checkbox" [checked]="!!b.create?.chips?.includes(c.id)" (change)="toggleChip('create', c.id, chk($event))" /> {{ c.label }}</label>
                }
              </fieldset>
              <span class="help">{{ 'ui.builder.listView.everyChip' | t }}</span>
              <span class="lv-label">{{ 'ui.builder.schema.prop.presets' | t }}</span>
              <ul class="lv-presets">
                @for (p of b.create?.presets ?? []; track p.param; let pi = $index) {
                  <li><code>{{ p.param }}</code> → {{ labelOf(p.field) }} <button type="button" class="small" [attr.aria-label]="('ui.common.remove' | t) + ': ' + p.param" (click)="edit(ops.removePreset, pi)">✕</button></li>
                }
              </ul>
              <div class="lv-add">
                <input [attr.aria-label]="'ui.builder.schema.prop.param' | t" [placeholder]="'ui.builder.schema.prop.param' | t" [value]="presetParam()" (input)="presetParam.set(val($event))" />
                <select [attr.aria-label]="'ui.builder.schema.prop.field' | t" (change)="presetField.set(val($event))">
                  <option value="" [selected]="!presetField()"></option>
                  @for (o of enterable(); track o.key) { <option [value]="o.key" [selected]="o.key === presetField()">{{ o.label }}</option> }
                </select>
                <button type="button" class="small" [disabled]="!presetParam().trim() || !presetField()" (click)="addPreset()">{{ 'ui.common.add' | t }}</button>
              </div>
            </section>

            <section class="lv-section">
              <h3 class="lv-title">{{ 'ui.builder.schema.prop.edit' | t }}</h3>
              <span class="lv-label">{{ 'ui.builder.schema.prop.fields' | t }}</span>
              <app-field-pills id="edit-fields" [label]="'ui.builder.schema.prop.fields' | t" [keys]="b.edit?.fields ?? []" [options]="enterable()" (changed)="edit(ops.setEditFields, $event)" />
              <div class="lv-layout">
                <label class="lv-label" for="edit-columns">{{ 'ui.builder.listView.formColumns' | t }}</label>
                <select id="edit-columns" (change)="setColumns('edit', val($event))">
                  @for (n of columnChoices; track n) { <option [value]="n" [selected]="(b.edit?.columns ?? 1) === n">{{ n }}</option> }
                </select>
                <fieldset class="lv-checks">
                  <legend>{{ 'ui.builder.listView.fullWidth' | t }}</legend>
                  @for (o of editOptions(); track o.key) {
                    <label><input type="checkbox" [checked]="!!b.edit?.fullWidth?.includes(o.key)" (change)="toggleFullWidth('edit', o.key, chk($event))" /> {{ o.label }}</label>
                  }
                </fieldset>
              </div>
              <fieldset class="lv-checks">
                <legend>{{ 'ui.builder.listView.allowedOn' | t }}</legend>
                @for (c of b.chips ?? []; track c.id) {
                  <label><input type="checkbox" [checked]="!!b.edit?.chips?.includes(c.id)" (change)="toggleChip('edit', c.id, chk($event))" /> {{ c.label }}</label>
                }
              </fieldset>
              <span class="help">{{ 'ui.builder.listView.everyChip' | t }}</span>
            </section>
          </div>
        </div>

        <aside class="lv-preview" [attr.aria-label]="'ui.builder.preview.title' | t">
          <h3 class="lv-title">{{ 'ui.builder.preview.title' | t }}</h3>
          @if (store.preview(); as p) {
            <app-live-preview
              [spec]="p.spec"
              [rows]="store.previewRows()"
              [record]="store.previewRecord()"
              [create]="store.previewSteps()"
              [(view)]="store.previewView"
              [(chip)]="store.previewChip"
              [(selectedId)]="store.previewRow" />
            <p class="help">{{ (store.sample() ? 'ui.builder.listView.sampleRecords' : 'ui.builder.listView.realRecords') | t }}</p>
          } @else {
            <p class="muted">{{ 'ui.common.loading' | t }}</p>
          }
        </aside>
      </div>

      <ng-template #requiredNotice>
        @if (store.missingRequired().length) {
          <div class="notice error" role="alert">⚠ {{ 'ui.builder.listView.missingRequired' | t: { fields: missingText() } }}</div>
        } @else if (b.create) {
          <div class="notice ok" role="status">✓ {{ 'ui.builder.listView.allRequired' | t }}</div>
        }
      </ng-template>

      <app-mobile-form-sheet [open]="store.createOpen()" [title]="'ui.builder.schema.prop.create' | t" [showDefaultFooter]="false" (dismissed)="store.openCreate(false)">
        <app-chip-filter-bar [chips]="createModes()" [activeId]="mode()" (chipSelect)="setMode($any($event))" />
        @if (mode() === 'page') {
          <app-field-pills id="create-page" [label]="'ui.builder.schema.prop.fields' | t" [keys]="pageFields()" [options]="enterable()" (changed)="edit(ops.setCreatePageFields, $event)" />
        } @else {
          <p class="help">{{ 'ui.builder.listView.dragHint' | t }}</p>
          <div class="lv-steps">
            @for (s of b.create?.steps ?? []; track $index; let si = $index) {
              <div class="lv-step">
                <div class="field">
                  <label [for]="'lv-step-' + si">{{ 'ui.builder.listView.step' | t: { n: si + 1 } }}</label>
                  <input [id]="'lv-step-' + si" [value]="s.label" (input)="edit(ops.setCreateStepLabel, si, val($event))" />
                </div>
                <app-field-pills
                  group="steps"
                  [id]="'step-' + si"
                  [label]="s.label"
                  [keys]="s.fields"
                  [options]="enterable()"
                  (changed)="edit(ops.setCreateStepFields, si, $event)"
                  (received)="place($event, si)" />
                <button type="button" class="small" (click)="edit(ops.removeCreateStep, si)">{{ 'ui.builder.workflow.removeStep' | t }}</button>
              </div>
            }
          </div>
          <button type="button" class="small" (click)="edit(ops.addCreateStep, '')">{{ 'ui.builder.workflow.addStep' | t }}</button>
        }
        <ng-container *ngTemplateOutlet="requiredNotice" />
        <div class="lv-layout">
          <label class="lv-label" for="create-columns">{{ 'ui.builder.listView.formColumns' | t }}</label>
          <select id="create-columns" (change)="setColumns('create', val($event))">
            @for (n of columnChoices; track n) { <option [value]="n" [selected]="(b.create?.columns ?? 1) === n">{{ n }}</option> }
          </select>
          <fieldset class="lv-checks">
            <legend>{{ 'ui.builder.listView.fullWidth' | t }}</legend>
            @for (o of createOptions(); track o.key) {
              <label><input type="checkbox" [checked]="!!b.create?.fullWidth?.includes(o.key)" (change)="toggleFullWidth('create', o.key, chk($event))" /> {{ o.label }}</label>
            }
          </fieldset>
        </div>
        <button sheetFooterActions type="button" class="app-btn app-btn--primary" (click)="store.openCreate(false)">{{ 'ui.common.close' | t }}</button>
      </app-mobile-form-sheet>
    } @else {
      <p class="muted">{{ 'ui.common.loading' | t }}</p>
    }
  `,
})
export class ListViewEditor {
  readonly store = inject(ListViewEditorStore);
  readonly ops = ops;
  readonly limits = ops.LIST_LIMITS;
  readonly shows = SHOWS;
  readonly showsLabel = SHOWS_LABEL;
  readonly chipShows = ops.chipShows;
  readonly presetParam = signal('');
  readonly presetField = signal('');

  readonly chip = computed(() => this.store.body()?.chips?.[this.store.chipIndex()] ?? null);
  readonly section = computed(() => this.store.body()?.detail?.sections[this.store.sectionIndex()] ?? null);
  readonly mode = computed(() => (this.store.body() ? ops.createMode(this.store.body()!) : 'page'));
  /** The record types the app can show, plus the list view's own when it is not (yet) among them. */
  readonly recordTypes = computed(() => {
    const own = this.store.recordTypeKey();
    const all = this.store.types().map((x) => ({ key: x.key, label: x.label }));
    return own && !all.some((x) => x.key === own) ? [{ key: own, label: own }, ...all] : all;
  });
  readonly primaryStates = computed(() => this.store.workflows()[0]?.states ?? []);

  readonly showable = computed<FieldOption[]>(() => {
    const type = this.store.type();
    if (!type) return [];
    const pseudo = ops.PSEUDO_KEYS.filter((k) => (k === 'number' ? !!type.numbering : k === 'status' ? !!this.store.workflows().length : true));
    return [...pseudo.map((k) => ({ key: k, label: fieldLabel(type, k) })), ...ops.columnFields(type).map((f) => ({ key: f.key, label: f.label }))];
  });
  readonly filterOptions = computed<FieldOption[]>(() => (this.store.type() ? ops.filterableFields(this.store.type()!).map((f) => ({ key: f.key, label: f.label })) : []));
  readonly enterable = computed<FieldOption[]>(() => (this.store.type() ? ops.enterableFields(this.store.type()!).map((f) => ({ key: f.key, label: f.label })) : []));
  readonly related = (s: ListViewSection) => (ops.isRelated(s) ? s : null);
  readonly fieldsOf = (s: ListViewSection) => (ops.isRelated(s) ? null : s.fields);
  readonly relatedTypes = computed(() => {
    const links = ops.relatedChoices(this.store.types(), this.store.recordTypeKey());
    return [...new Map(links.map((l) => [l.recordType, { key: l.recordType, label: l.label }])).values()];
  });
  readonly pageFields = computed(() => this.store.body()?.create?.fields ?? []);
  readonly createText = computed(() => (this.store.body() ? createSummary(this.store.body()!, this.enterable().length) : ''));
  readonly missingText = computed(() => this.store.missingRequired().map((f) => f.label).join(', '));

  readonly chipColumns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.label') },
    { key: 'shows', label: t('ui.builder.listView.shows') },
    { key: 'only', label: t('ui.builder.listView.onlyFor') },
    { key: 'default', label: t('ui.builder.schema.prop.defaultChip') },
  ]);
  readonly sectionColumns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.label') },
    { key: 'shows', label: t('ui.builder.listView.shows') },
    { key: 'kind', label: t('ui.builder.kindLabel') },
    { key: 'permission', label: t('ui.builder.listView.shownTo') },
  ]);
  readonly sectionKinds = computed(() => [
    { id: 'fields', label: t('ui.builder.listView.ofRecord') },
    { id: 'related', label: t('ui.builder.schema.prop.related') },
  ]);
  readonly createModes = computed(() => [
    { id: 'page', label: t('ui.builder.listView.onePage') },
    { id: 'steps', label: t('ui.builder.schema.prop.steps') },
  ]);

  /** Applies one operation to the draft, e.g. `edit(ops.moveChip, from, to)`. */
  edit<A extends unknown[]>(op: (b: ListViewDef, ...args: A) => ListViewDef, ...args: A): void {
    this.store.edit(((b) => op(b, ...args)) as Edit);
  }

  setShows(index: number, shows: string): void {
    this.edit(ops.setChipShows, index, shows as ops.ChipShows, this.store.workflows().find((w) => w.role === 'parallel')?.key);
  }

  readonly conditionFields = computed(() => (this.store.type() ? ops.filterableFields(this.store.type()!) : []));

  conditionEntries(c: ops.ChipDef): { field: string; filter: NonNullable<ops.ChipDef['filters']>[string] }[] {
    return Object.entries(c.filters ?? {}).map(([field, filter]) => ({ field, filter }));
  }

  fieldDef(key: string): FieldDef | undefined {
    return this.conditionFields().find((f) => f.key === key);
  }

  unusedFields(c: ops.ChipDef): FieldDef[] {
    const used = new Set(Object.keys(c.filters ?? {}));
    return this.conditionFields().filter((f) => !used.has(f.key));
  }

  addCondition(index: number, event: Event): void {
    const el = event.target as HTMLSelectElement;
    const field = el.value;
    el.value = '';
    if (field) this.edit(ops.addChipCondition, index, field);
  }

  setFlag(index: number, field: string, value: string): void {
    this.edit(ops.setChipEquals, index, field, value === 'true' ? true : value === 'false' ? false : null);
  }

  setBound(index: number, field: FieldDef, side: 'from' | 'to', raw: string): void {
    if (raw === '') {
      this.edit(ops.setChipBound, index, field.key, side, null);
      return;
    }
    const value = field.type === 'date' ? raw : Number(raw);
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    this.edit(ops.setChipBound, index, field.key, side, value);
  }

  setRowPart(part: RowPart, key: string): void {
    this.edit(ops.setRow, { [part]: key });
  }

  rowValue(part: RowPart): string {
    return this.store.body()?.row?.[part] ?? '';
  }

  setMode(mode: ops.CreateMode): void {
    const type = this.store.type();
    const fallback = this.store.preview()?.spec.createKeys ?? [];
    this.edit(ops.setCreateMode, mode, type?.label ?? '', fallback);
  }

  place(drop: FieldDrop, step: number): void {
    this.edit(ops.placeCreateField, drop.field, step, drop.index);
  }

  /** Columns on wide screens for the create or edit form; phones always draw one. */
  readonly columnChoices: FormColumns[] = [1, 2, 3];

  setColumns(form: 'create' | 'edit', value: string): void {
    const columns = Number(value) as FormColumns;
    this.edit(form === 'create' ? ops.setCreateColumns : ops.setEditColumns, columns);
  }

  /** Puts a field on its own row, or back into the grid. */
  toggleFullWidth(form: 'create' | 'edit', key: string, on: boolean): void {
    const b = this.store.body();
    const current = (form === 'create' ? b?.create?.fullWidth : b?.edit?.fullWidth) ?? [];
    const next = on ? [...current.filter((k) => k !== key), key] : current.filter((k) => k !== key);
    this.edit(form === 'create' ? ops.setCreateFullWidth : ops.setEditFullWidth, next);
  }

  /** The fields a form holds, in order; every enterable field while the list names none. */
  private formOptions(keys: readonly string[]): FieldOption[] {
    const labels = new Map(this.enterable().map((o) => [o.key, o.label]));
    return (keys.length ? keys : [...labels.keys()]).map((key) => ({ key, label: labels.get(key) ?? key }));
  }
  readonly createOptions = computed<FieldOption[]>(() => (this.store.body() ? this.formOptions(ops.createFields(this.store.body()!)) : []));
  readonly editOptions = computed<FieldOption[]>(() => (this.store.body() ? this.formOptions(this.store.body()!.edit?.fields ?? []) : []));

  toggleChip(form: 'create' | 'edit', id: string, on: boolean): void {
    const b = this.store.body();
    const current = (form === 'create' ? b?.create?.chips : b?.edit?.chips) ?? [];
    const next = on ? [...current.filter((c) => c !== id), id] : current.filter((c) => c !== id);
    this.edit(form === 'create' ? ops.setCreateChips : ops.setEditChips, next);
  }

  addPreset(): void {
    this.edit(ops.addPreset, this.presetParam(), this.presetField());
    this.presetParam.set('');
    this.presetField.set('');
  }

  statesOf(workflow: string) {
    return this.store.workflows().find((w) => w.key === workflow)?.states ?? [];
  }

  linksFrom(recordType: string) {
    return ops.relatedChoices(this.store.types(), this.store.recordTypeKey()).filter((l) => l.recordType === recordType);
  }

  totalsOf(recordType: string) {
    return ops.totalFields(this.store.types().find((x) => x.key === recordType));
  }

  labelOf(key: string): string {
    return this.enterable().find((o) => o.key === key)?.label ?? key;
  }

  layoutOf(v: string): ListLayout | undefined {
    return v === 'cards' || v === 'table' ? v : undefined;
  }

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  num(e: Event): number | null {
    const v = (e.target as HTMLInputElement).value;
    return v === '' ? null : Number(v);
  }

  chk(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }
}
