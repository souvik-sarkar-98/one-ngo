import { Component, computed, inject } from '@angular/core';
import { t } from '../../../core/i18n/i18n';
import { TranslatePipe } from '../../../services/i18n';
import { ChipFilterBar } from '../../../ui/chip-bar';
import { EditableTable } from '../../../ui/editable-table';
import type { TableColumn } from '../../../ui/table-rows';
import { Widget } from '../../../ui/widget';
import { PageEditorStore, type PreviewSource } from './page-store';
import { PageWidgetPanel } from './widget-panel';

/**
 * The Visual tab of a page (Builder 20 and 26): who sees it, its widgets in
 * order with the selected one's settings, and a live preview drawn with the
 * same widgets as Home.
 */
@Component({
  selector: 'app-page-editor',
  imports: [TranslatePipe, ChipFilterBar, EditableTable, Widget, PageWidgetPanel],
  providers: [PageEditorStore],
  styleUrl: './page.css',
  template: `
    @if (store.body(); as b) {
      <div class="pg-layout">
        <div>
          <section class="pg-section" aria-labelledby="pg-page-title">
            <h3 class="pg-title" id="pg-page-title">{{ 'ui.builder.page.page' | t }}</h3>
            <div class="pg-grid">
              <div class="field">
                <label for="pg-page-label">{{ 'ui.builder.label' | t }}</label>
                <input id="pg-page-label" maxlength="60" [value]="b.label" (input)="store.setLabel(val($event) || b.label)" />
              </div>
              <p class="help">{{ 'ui.builder.page.placementHint' | t }}</p>
            </div>
            <fieldset class="pg-checks">
              <legend>{{ 'ui.builder.schema.prop.audience' | t }}</legend>
              @for (r of store.roles(); track r.key) {
                <label class="pg-check"><input type="checkbox" [checked]="(b.audience ?? []).includes(r.key)" (change)="store.toggleAudience(r.key, chk($event))" /> {{ r.label }}</label>
              }
              <span class="help">{{ (b.audience?.length ? 'ui.builder.page.audienceSome' : 'ui.builder.page.audienceAll') | t }}</span>
            </fieldset>
          </section>

          <section class="pg-section" aria-labelledby="pg-widgets-title">
            <h3 class="pg-title" id="pg-widgets-title">{{ 'ui.builder.page.widgetsCount' | t: { count: b.widgets.length } }}</h3>
            <app-editable-table
              [rows]="store.rows()"
              [columns]="columns()"
              badgeKey="type"
              [selectedId]="selectedId()"
              [labels]="tableLabels()"
              [addable]="b.widgets.length < 24"
              (rowSelect)="store.select($event === null ? null : +$event)"
              (moved)="store.move($event.from, $event.to)"
              (add)="store.add('stat')"
              (remove)="store.remove(+$event)">
              @if (store.selected(); as w) {
                <app-page-widget-panel rowPanel [widget]="w" [index]="store.selectedIndex()" />
              }
            </app-editable-table>
          </section>
        </div>

        <aside class="pg-preview" [attr.aria-label]="'ui.builder.preview.title' | t">
          <app-chip-filter-bar [chips]="sources()" [activeId]="store.source()" (chipSelect)="store.useSource($any($event))" />
          <div class="pg-preview__page">
            @for (p of store.preview(); track p.index) {
              <div class="pg-preview__item" [class.pg-preview__item--on]="p.index === store.selectedIndex()" (click)="store.select(p.index)">
                @if (p.model; as m) {
                  <app-widget [widget]="m" [loading]="p.loading" [error]="p.error" [format]="store.format" (retry)="store.retry(p.index)" />
                } @else {
                  <p class="pg-preview__empty">{{ 'ui.builder.page.notReady' | t }}</p>
                }
              </div>
            } @empty {
              <p class="muted">{{ 'ui.builder.page.noWidgets' | t }}</p>
            }
          </div>
          <p class="help">{{ 'ui.builder.page.previewNote' | t }}</p>
        </aside>
      </div>
    } @else {
      <p class="muted">{{ 'ui.common.loading' | t }}</p>
    }
  `,
})
export class PageEditor {
  readonly store = inject(PageEditorStore);

  readonly selectedId = computed(() => (this.store.selectedIndex() >= 0 ? String(this.store.selectedIndex()) : null));
  readonly columns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.label') },
    { key: 'type', label: t('ui.builder.schema.prop.type') },
    { key: 'shows', label: t('ui.builder.page.shows.title') },
  ]);
  readonly tableLabels = computed(() => ({ add: t('ui.builder.page.addWidget') }));
  readonly sources = computed<{ id: PreviewSource; label: string }[]>(() => [
    { id: 'real', label: t('ui.builder.page.realFigures') },
    { id: 'sample', label: t('ui.builder.page.sampleData') },
  ]);

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  chk(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }
}
