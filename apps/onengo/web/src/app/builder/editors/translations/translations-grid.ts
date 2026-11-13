import { Component, computed, input, output, signal } from '@angular/core';
import { TRANSLATION_AREAS, filterTranslationRows, type TranslationArea, type TranslationFilter, type TranslationRow } from '../../../core/builder/translations';
import { t } from '../../../core/i18n/i18n';
import type { RowView, Tone } from '../../../core/rows';
import { TranslatePipe } from '../../../services/i18n';
import { EditableTable } from '../../../ui/editable-table';
import type { TableColumn } from '../../../ui/table-rows';

const PAGE = 100;
const TONES: Record<TranslationRow['origin'], Tone> = { organisation: 'primary', app: 'neutral', missing: 'warning' };

export const areaName = (area: TranslationArea): string => (area === 'ui' ? t('ui.builder.translations.screenText') : t(`ui.builder.kinds.${area}`));

/**
 * Every translatable path of one language with the English text beside its
 * translation (Builder 22). Choosing a row opens its translation; changes are
 * reported, never applied here.
 */
@Component({
  selector: 'app-translations-grid',
  imports: [TranslatePipe, EditableTable],
  styleUrl: './translations.css',
  template: `
    <div class="tr-tools">
      <input
        type="search"
        class="tr-search"
        [attr.aria-label]="'ui.builder.translations.search' | t"
        [placeholder]="'ui.builder.translations.search' | t"
        [value]="filter().q"
        (input)="filterChange.emit({ q: val($event) })" />
      <label class="tr-check"><input type="checkbox" [checked]="filter().missing" (change)="filterChange.emit({ missing: chk($event) })" /> {{ 'ui.builder.translations.missingOnly' | t }}</label>
      <select [attr.aria-label]="'ui.builder.translations.area' | t" (change)="filterChange.emit({ area: $any(val($event)) || undefined })">
        <option value="" [selected]="!filter().area">{{ 'ui.builder.translations.allAreas' | t }}</option>
        @for (a of areas(); track a.id) { <option [value]="a.id" [selected]="a.id === filter().area">{{ a.label }}</option> }
      </select>
      <span class="muted">{{ 'ui.builder.translations.shown' | t: { count: shown().length } }}</span>
    </div>

    @if (stale().length) {
      <div class="notice info" role="status">
        ⚠ {{ 'ui.builder.translations.stale' | t: { count: stale().length } }}
        <ul class="tr-stale">@for (p of stale(); track p) { <li><code>{{ p }}</code></li> }</ul>
        @if (editable()) { <button type="button" class="small" (click)="removeStale.emit()">{{ 'ui.builder.translations.removeStale' | t }}</button> }
      </div>
    }

    <app-editable-table
      [rows]="rowViews()"
      [columns]="columns()"
      badgeKey="from"
      [selectedId]="selectedPath()"
      [reorderable]="false"
      [addable]="false"
      [removable]="false"
      (rowSelect)="selectedPath.set($event)">
      @if (selected(); as r) {
        <div rowPanel class="tr-panel">
          <div class="field">
            <span class="tr-label">{{ 'ui.builder.translations.english' | t }}</span>
            <p class="tr-english">{{ r.english }}</p>
          </div>
          <div class="field">
            <label for="tr-text">{{ localeName() }}</label>
            <textarea id="tr-text" rows="3" [value]="r.translation" [disabled]="!editable()" (input)="live() && entryChange.emit({ path: r.path, value: val($event) })" (change)="!live() && entryChange.emit({ path: r.path, value: val($event) })"></textarea>
            <span class="help">{{ (r.origin === 'app' ? 'ui.builder.translations.appHint' : 'ui.builder.translations.clearHint') | t }}</span>
          </div>
          @if (r.lost.length) {
            <div class="notice error" role="alert">{{ 'ui.builder.translations.keep' | t: { placeholders: r.lost.join(', ') } }}</div>
          }
        </div>
      }
    </app-editable-table>
    @if (shown().length > limit()) {
      <button type="button" class="tr-more" (click)="limit.set(limit() + page)">{{ 'ui.common.loadMore' | t }}</button>
    }
  `,
})
export class TranslationsGrid {
  readonly rows = input.required<TranslationRow[]>();
  readonly filter = input.required<TranslationFilter>();
  readonly localeName = input('');
  readonly stale = input<string[]>([]);
  readonly editable = input(true);
  /** Reports each keystroke; otherwise only when the translation is left. */
  readonly live = input(true);
  readonly entryChange = output<{ path: string; value: string }>();
  readonly filterChange = output<Partial<TranslationFilter>>();
  readonly removeStale = output<void>();

  readonly page = PAGE;
  readonly limit = signal(PAGE);
  readonly selectedPath = signal<string | null>(null);
  readonly shown = computed(() => filterTranslationRows(this.rows(), this.filter()));
  readonly selected = computed(() => this.rows().find((r) => r.path === this.selectedPath()) ?? null);
  readonly areas = computed(() => TRANSLATION_AREAS.map((id) => ({ id, label: areaName(id) })));
  readonly columns = computed<TableColumn[]>(() => [
    { key: 'title', label: t('ui.builder.translations.path') },
    { key: 'english', label: t('ui.builder.translations.english') },
    { key: 'translation', label: this.localeName() },
    { key: 'from', label: t('ui.builder.translations.from') },
  ]);
  readonly rowViews = computed<RowView[]>(() => {
    const missing = t('ui.builder.translations.missingCell');
    return this.shown()
      .slice(0, this.limit())
      .map((r) => ({
        id: r.path,
        title: r.path,
        badge: r.lost.length ? { label: t('ui.builder.translations.placeholderLost'), tone: 'danger' } : { label: t(`ui.builder.translations.origin.${r.origin}`), tone: TONES[r.origin] },
        cells: [
          { key: 'english', label: t('ui.builder.translations.english'), value: r.english },
          { key: 'translation', label: this.localeName(), value: r.translation || missing },
        ],
        actions: [],
      }));
  });

  val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  chk(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }
}
