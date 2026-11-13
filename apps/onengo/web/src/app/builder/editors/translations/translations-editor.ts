import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { removeEntries, setEntry, type TranslationBody } from '../../../core/builder/ops/translation';
import { staleEntries, translationRows, type TranslationFilter } from '../../../core/builder/translations';
import { languageName } from '../../../core/i18n/languages';
import { TranslatePipe } from '../../../services/i18n';
import { BuilderStore } from '../../builder-store';
import { TranslationSourcesStore } from './translation-sources';
import { TranslationsGrid } from './translations-grid';
import { TranslationsStore, type GridFilter } from './translations-store';

/**
 * The Visual tab of a translation definition: the grid of its language,
 * saving each entry into the draft. On the translations screen the filter
 * is kept in the address; opened from the catalogue it is kept here.
 */
@Component({
  selector: 'app-translations-editor',
  imports: [TranslatePipe, TranslationsGrid],
  template: `
    @if (sources.failed()) {
      <div class="notice error" role="alert">{{ 'ui.common.loadFailed' | t }}</div>
    } @else if (!body() || !rows()) {
      <p class="muted">{{ 'ui.common.loading' | t }}</p>
    } @else {
      <app-translations-grid
        [rows]="rows()!"
        [filter]="grid.filter()"
        [localeName]="localeName()"
        [stale]="stale()"
        [editable]="builder.canEdit()"
        (entryChange)="setEntry($event.path, $event.value)"
        (filterChange)="grid.setFilter($event)"
        (removeStale)="removeStale()" />
    }
  `,
})
export class TranslationsEditor {
  readonly builder = inject(BuilderStore);
  readonly sources = inject(TranslationSourcesStore);
  private readonly local = signal<TranslationFilter>({ missing: false, q: '' });
  readonly grid: GridFilter = inject(TranslationsStore, { optional: true }) ?? {
    filter: this.local,
    setFilter: (change) => this.local.update((f) => ({ ...f, ...change })),
  };

  readonly body = computed(() => this.builder.body() as unknown as TranslationBody | null);
  readonly locale = computed(() => this.body()?.locale ?? '');
  readonly localeName = computed(() => languageName(this.locale()));
  readonly rows = computed(() => {
    const src = this.sources.sources(this.locale());
    const b = this.body();
    return src && b ? translationRows(src, b.entries ?? {}) : null;
  });
  readonly stale = computed(() => {
    const rows = this.rows();
    return rows ? staleEntries(this.body()?.entries ?? {}, rows) : [];
  });

  constructor() {
    if (!this.sources.definitions()) void this.sources.load();
    effect(() => {
      const locale = this.locale();
      if (locale) untracked(() => void this.sources.ensureShipped(locale));
    });
    effect(() => {
      const b = this.body();
      if (b?.locale) untracked(() => this.sources.remember({ key: b.key, locale: b.locale, entries: b.entries ?? {} }));
    });
  }

  setEntry(path: string, value: string): void {
    const b = this.body();
    if (b) this.builder.edit(setEntry(b, path, value) as unknown as Record<string, unknown>);
  }

  removeStale(): void {
    const b = this.body();
    if (b) this.builder.edit(removeEntries(b, this.stale()) as unknown as Record<string, unknown>);
  }
}
