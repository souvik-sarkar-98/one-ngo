import { Component, computed, inject, input } from '@angular/core';
import { WIDGET_TYPES, widgetTypeName, type GroupBy, type WidgetType } from '../../../core/builder/ops/page';
import type { FieldType, PageWidget } from '../../../core/models';
import { TranslatePipe } from '../../../services/i18n';
import { PermissionField } from '../../../ui/permission-field';
import { PageEditorStore } from './page-store';

const SUMMABLE: FieldType[] = ['number', 'money'];
const GROUPABLE: FieldType[] = ['choice', 'boolean', 'reference'];
const DATES: FieldType[] = ['date'];
const PERIODS = ['day', 'week', 'month', 'financialYear'] as const;

/** The settings of the selected widget: its kind, label, what it shows, and who sees it. */
@Component({
  selector: 'app-page-widget-panel',
  imports: [TranslatePipe, PermissionField],
  styleUrl: './page.css',
  template: `
    @let w = widget();
    @let i = index();
    <div class="pg-panel">
      <div class="field">
        <label for="pg-type">{{ 'ui.builder.schema.prop.type' | t }}</label>
        <select id="pg-type" (change)="store.changeType(i, $any(val($event)))">
          @for (type of types; track type) { <option [value]="type" [selected]="type === w.type">{{ typeName(type) }}</option> }
        </select>
      </div>
      @if (w.type !== 'groups') {
        <div class="field">
          <label for="pg-label">{{ 'ui.builder.label' | t }}</label>
          <input id="pg-label" maxlength="60" [value]="w.label" (input)="store.set(i, { label: val($event) || w.label })" />
        </div>
      }

      @if (w.type === 'stat' || w.type === 'chart') {
        <div class="field">
          <label for="pg-rt">{{ 'ui.builder.schema.prop.recordType' | t }}</label>
          <select id="pg-rt" (change)="store.set(i, { recordType: val($event), field: undefined, view: undefined })">
            <option value="" [selected]="!w.recordType">{{ 'ui.builder.page.choose' | t }}</option>
            @for (rt of recordTypes(); track rt.key) { <option [value]="rt.key" [selected]="rt.key === w.recordType">{{ rt.label }}</option> }
          </select>
        </div>
        <div class="field">
          <label for="pg-measure">{{ 'ui.builder.schema.prop.measure' | t }}</label>
          <select id="pg-measure" (change)="store.set(i, { measure: val($event) })">
            <option value="count" [selected]="w.measure === 'count'">{{ 'ui.builder.schema.enum.count' | t }}</option>
            <option value="sum" [selected]="w.measure === 'sum'">{{ 'ui.builder.schema.enum.sum' | t }}</option>
          </select>
        </div>
        @if (w.measure === 'sum') {
          <div class="field">
            <label for="pg-field">{{ 'ui.builder.schema.prop.field' | t }}</label>
            <select id="pg-field" (change)="store.set(i, { field: val($event) })">
              <option value="" [selected]="!w.field">{{ 'ui.builder.page.choose' | t }}</option>
              @for (f of store.fields(w.recordType, summable); track f.key) { <option [value]="f.key" [selected]="f.key === w.field">{{ f.label }}</option> }
            </select>
            <span class="help">{{ 'ui.builder.page.sumHint' | t }}</span>
          </div>
        }
        @if (w.type === 'chart') {
          <div class="field">
            <label for="pg-by">{{ 'ui.builder.schema.prop.groupBy' | t }}</label>
            <select id="pg-by" (change)="groupBy(val($event))">
              @for (p of periods; track p) { <option [value]="p" [selected]="period() === p">{{ 'ui.builder.schema.enum.' + p | t }}</option> }
              @for (f of store.fields(w.recordType, groupable); track f.key) { <option [value]="'field:' + f.key" [selected]="byField() === f.key">{{ f.label }}</option> }
            </select>
          </div>
          @if (period()) {
            <div class="field">
              <label for="pg-date">{{ 'ui.builder.schema.prop.dateField' | t }}</label>
              <select id="pg-date" (change)="store.setGroupBy(i, { period: period()!, dateField: val($event) })">
                <option value="createdAt" [selected]="dateField() === 'createdAt'">{{ 'ui.builder.page.createdAt' | t }}</option>
                @for (f of store.fields(w.recordType, dates); track f.key) { <option [value]="f.key" [selected]="f.key === dateField()">{{ f.label }}</option> }
              </select>
            </div>
          }
          <div class="field">
            <label for="pg-chart">{{ 'ui.builder.schema.prop.chart' | t }}</label>
            <select id="pg-chart" (change)="store.set(i, { chart: val($event) })">
              <option value="bar" [selected]="w.chart === 'bar'">{{ 'ui.builder.schema.enum.bar' | t }}</option>
              <option value="line" [selected]="w.chart === 'line'">{{ 'ui.builder.schema.enum.line' | t }}</option>
            </select>
          </div>
        }
      }

      @if (w.type === 'list') {
        <div class="field">
          <label for="pg-lv">{{ 'ui.builder.schema.prop.listView' | t }}</label>
          <select id="pg-lv" (change)="store.set(i, { listView: val($event), view: undefined })">
            <option value="" [selected]="!w.listView">{{ 'ui.builder.page.choose' | t }}</option>
            @for (lv of store.listViews(); track lv.key) { <option [value]="lv.key" [selected]="lv.key === w.listView">{{ lv.label }}</option> }
          </select>
        </div>
        <div class="field">
          <label for="pg-limit">{{ 'ui.builder.schema.prop.limit' | t }}</label>
          <input id="pg-limit" type="number" min="1" max="20" [value]="w.limit" (change)="limit(val($event))" />
        </div>
      }

      @if (w.type === 'stat' || w.type === 'chart' || w.type === 'list') {
        @let view = viewOf();
        <div class="field">
          <label for="pg-chip">{{ 'ui.builder.schema.prop.chip' | t }}</label>
          <select id="pg-chip" (change)="store.setView(i, { chip: val($event) || undefined })">
            <option value="" [selected]="!view.chip">{{ 'ui.common.any' | t }}</option>
            @for (c of chips(); track c.id) { <option [value]="c.id" [selected]="c.id === view.chip">{{ c.label }}</option> }
          </select>
        </div>
        <label class="pg-check"><input type="checkbox" [checked]="view.owner === 'me'" (change)="store.setView(i, { owner: chk($event) ? 'me' : undefined })" /> {{ 'ui.builder.schema.enum.me' | t }}</label>
        @if (filterCount()) { <span class="help">{{ 'ui.builder.page.keepsFilters' | t: { count: filterCount() } }}</span> }
      }

      @if (w.type === 'links') {
        <fieldset class="pg-links">
          <legend>{{ 'ui.builder.schema.prop.items' | t }}</legend>
          @for (link of w.items; track $index; let n = $index) {
            <div class="pg-link">
              <div class="field">
                <label [for]="'pg-link-label-' + n">{{ 'ui.builder.page.linkText' | t }}</label>
                <input [id]="'pg-link-label-' + n" [value]="link.label" (input)="store.setLink(i, n, { label: val($event) || link.label })" />
              </div>
              <div class="field">
                <label [for]="'pg-link-to-' + n">{{ 'ui.builder.page.linkTo' | t }}</label>
                <input [id]="'pg-link-to-' + n" [value]="link.to" (change)="to(n, val($event))" />
              </div>
              <app-permission-field
                [label]="'ui.builder.page.linkPermission' | t"
                [value]="link.permission ?? ''"
                [source]="store.permissionSource"
                (valueChange)="store.setLink(i, n, { permission: $event })" />
              <div class="pg-link__tools">
                <button type="button" class="small" [disabled]="n === 0" (click)="store.moveLink(i, n, n - 1)">{{ 'ui.pins.moveUp' | t }}</button>
                <button type="button" class="small" [disabled]="w.items.length < 2" (click)="store.removeLink(i, n)">{{ 'ui.common.remove' | t }}</button>
              </div>
            </div>
          }
          <button type="button" class="small" (click)="store.addLink(i)">{{ 'ui.builder.page.addLink' | t }}</button>
          <span class="help">{{ 'ui.builder.page.linkHint' | t }}</span>
        </fieldset>
      }

      <app-permission-field
        [label]="'ui.builder.page.widgetPermission' | t"
        [hint]="'ui.builder.page.widgetPermissionHint' | t"
        [value]="w.permission ?? ''"
        [source]="store.permissionSource"
        (valueChange)="store.setPermission(i, $event)" />
    </div>
  `,
})
export class PageWidgetPanel {
  readonly store = inject(PageEditorStore);
  readonly widget = input.required<PageWidget>();
  readonly index = input.required<number>();

  readonly types = WIDGET_TYPES;
  readonly periods = PERIODS;
  readonly summable = SUMMABLE;
  readonly groupable = GROUPABLE;
  readonly dates = DATES;
  readonly recordTypes = this.store.recordTypes;

  private readonly groupByOf = computed<GroupBy | null>(() => {
    const w = this.widget();
    return w.type === 'chart' ? w.groupBy : null;
  });
  readonly period = computed(() => {
    const g = this.groupByOf();
    return g && 'period' in g ? g.period : null;
  });
  readonly dateField = computed(() => {
    const g = this.groupByOf();
    return g && 'dateField' in g ? g.dateField : '';
  });
  readonly byField = computed(() => {
    const g = this.groupByOf();
    return g && 'field' in g ? g.field : null;
  });
  readonly viewOf = computed(() => {
    const w = this.widget();
    return ('view' in w && w.view) || {};
  });
  readonly filterCount = computed(() => Object.keys(this.viewOf().filters ?? {}).length);
  readonly chips = computed(() => {
    const w = this.widget();
    return w.type === 'list' ? this.store.listChips(w.listView) : w.type === 'stat' || w.type === 'chart' ? this.store.chips(w.recordType) : [];
  });

  typeName(type: WidgetType): string {
    return widgetTypeName(type);
  }

  groupBy(value: string): void {
    const i = this.index();
    if (value.startsWith('field:')) this.store.setGroupBy(i, { field: value.slice(6) });
    else this.store.setGroupBy(i, { period: value as (typeof PERIODS)[number], dateField: this.dateField() || 'createdAt' });
  }

  limit(value: string): void {
    const n = Math.round(Number(value));
    if (n >= 1 && n <= 20) this.store.set(this.index(), { limit: n });
  }

  /** Only addresses inside the app are kept; anything else stays as it was. */
  to(item: number, value: string): void {
    const v = value.trim();
    if (/^\/(?!\/)\S*$/.test(v)) this.store.setLink(this.index(), item, { to: v });
  }

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  chk(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }
}
