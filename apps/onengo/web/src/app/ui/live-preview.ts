import { Component, computed, input, model, signal } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { FieldModel, FormValues } from '../core/records/record/forms';
import type { DetailSection } from '../core/records/record/present';
import { tableColumns } from '../core/records/list/rows';
import type { ListSpec } from '../core/records/spec';
import type { RowView } from '../core/rows';
import { InfiniteListRow } from './card-rows';
import { CfFormStepper } from './cf-form';
import { cfField, type CfFieldDef } from './cf-types';
import { ChipFilterBar } from './chip-bar';
import { withDefaults } from './labels';
import { ListDetailSections } from './panel';
import { TableRows } from './table-rows';

export const LIVE_PREVIEW_VIEWS = ['phone', 'tablet', 'desktop', 'panel', 'create'] as const;
export type LivePreviewView = (typeof LIVE_PREVIEW_VIEWS)[number];

/** A page of the create form, as `core/builder/list-preview` gives it. */
export interface LivePreviewStep {
  key: string;
  label: string;
  fields: FieldModel[];
}

const LABELS = () => ({
  views: t('ui.livePreview.views'),
  phone: t('ui.livePreview.phone'),
  tablet: t('ui.livePreview.tablet'),
  desktop: t('ui.livePreview.desktop'),
  panel: t('ui.livePreview.panel'),
  create: t('ui.livePreview.create'),
  chooseRow: t('ui.livePreview.chooseRow'),
  empty: t('ui.records.empty'),
});

/** Fields that would upload or ask the device for something are shown but cannot be used. */
const INERT = new Set(['file', 'signature', 'location']);

/**
 * A list as people will see it, drawn with the real card rows, table rows,
 * record panel and create form: on a phone, a tablet, a desktop, one record's
 * panel, or the create form. The screen gives the spec, the rows and the open
 * record's sections; choosing a chip or a row is reported through the models.
 */
@Component({
  selector: 'app-live-preview',
  imports: [ChipFilterBar, InfiniteListRow, TableRows, ListDetailSections, CfFormStepper],
  styleUrl: './styles/live-preview.css',
  template: `
    <div class="live-preview">
      <div class="live-preview__views" role="tablist" [attr.aria-label]="labels().views">
        @for (v of views(); track v) {
          <button type="button" role="tab" class="live-preview__view" [class.live-preview__view--on]="v === view()" [attr.aria-selected]="v === view()" (click)="view.set(v)">
            {{ labels()[v] }}
          </button>
        }
      </div>

      <div class="live-preview__frame" [class]="'live-preview__frame--' + view()">
        @switch (view()) {
          @case ('panel') {
            @if (selected(); as r) {
              <h3 class="live-preview__record">{{ r.title }}</h3>
              <app-list-detail-sections [sections]="record()" />
            } @else {
              <p class="live-preview__note">{{ labels().chooseRow }}</p>
            }
          }
          @case ('create') {
            @for (s of steps(); track s.key; let i = $index) {
              <cf-form-stepper
                [stepLabel]="s.label"
                [stepIndex]="i"
                [stepCount]="steps().length"
                [fields]="s.fields"
                [values]="values()"
                [idPrefix]="'live-preview-' + s.key"
                (valuesChange)="values.set($event)" />
            }
          }
          @default {
            <div class="live-preview__bar">{{ spec().title }}</div>
            <app-chip-filter-bar [chips]="spec().chips" [activeId]="activeChip()" (chipSelect)="chip.set($event)" />
            @if (!rows().length) {
              <p class="live-preview__note">{{ labels().empty }}</p>
            } @else if (cards()) {
              <div class="live-preview__cards">
                @for (r of rows(); track r.id) {
                  <button type="button" class="live-preview__card" (click)="open(r.id)">
                    <app-infinite-list-row [item]="r" />
                  </button>
                }
              </div>
            } @else {
              <app-table-rows [rows]="rows()" [columns]="columns()" [selectedId]="selectedId()" (rowClick)="open($event.id)" />
            }
          }
        }
      </div>
      <ng-content></ng-content>
    </div>
  `,
})
export class LivePreview {
  readonly spec = input.required<ListSpec>();
  readonly rows = input.required<RowView[]>();
  /** The record panel of the selected row. */
  readonly record = input<DetailSection[]>([]);
  readonly create = input<LivePreviewStep[]>([]);
  readonly views = input<readonly LivePreviewView[]>(LIVE_PREVIEW_VIEWS);
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  readonly view = model<LivePreviewView>('phone');
  /** The chip shown as active; the spec's default when empty. */
  readonly chip = model('');
  readonly selectedId = model<string | null>(null);

  readonly values = signal<FormValues>({});
  readonly activeChip = computed(() => this.chip() || this.spec().defaultChip);
  readonly cards = computed(() => this.view() === 'phone' || (this.view() === 'desktop' && this.spec().layout === 'cards'));
  readonly columns = computed(() => tableColumns(this.spec(), this.view() === 'desktop').map(({ key, label }) => ({ key, label })));
  readonly selected = computed(() => this.rows().find((r) => r.id === this.selectedId()) ?? null);
  readonly steps = computed(() =>
    this.create().map((s) => ({ ...s, fields: s.fields.map((f): CfFieldDef => ({ ...cfField(f), ...(INERT.has(f.kind) ? { readOnly: true } : {}) })) })),
  );

  open(id: string): void {
    this.selectedId.set(id);
    if (this.views().includes('panel')) this.view.set('panel');
  }
}
