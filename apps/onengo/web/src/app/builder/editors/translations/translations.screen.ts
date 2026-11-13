import { Component, computed, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { translationRows } from '../../../core/builder/translations';
import { languageName } from '../../../core/i18n/languages';
import { TranslatePipe } from '../../../services/i18n';
import { ChipFilterBar } from '../../../ui/chip-bar';
import { PageBack } from '../../../ui/page-back';
import { EditorFrame } from '../../editor-frame';
import { TranslationsGrid } from './translations-grid';
import { TranslationsStore } from './translations-store';

/**
 * Translations (Builder 22, `/builder/translations?locale=hi`): a chip per
 * language with how much is translated, then that language's translation
 * definition in the editor frame. A language without one shows the grid
 * straight away; the first entry typed creates its draft.
 */
@Component({
  selector: 'app-translations-screen',
  imports: [TranslatePipe, ChipFilterBar, EditorFrame, TranslationsGrid, PageBack, PageFrame],
  providers: [TranslationsStore],
  styleUrl: './translations.css',
  template: `
    <app-page-frame>
      <app-chip-filter-bar [chips]="store.chips()" [activeId]="store.locale()" (chipSelect)="store.chooseLocale($event)" />
      @if (store.key(); as key) {
        <app-editor-frame kind="translation" [key]="key" />
      } @else {
        <header class="tr-head">
          <app-page-back />
          <h1 class="tr-title">{{ 'ui.builder.translations.title' | t: { name: localeName() } }}</h1>
        </header>
        @if (store.error()) { <div class="notice error" role="alert">{{ store.error() }}</div> }
        @if (store.sources.failed()) {
          <div class="notice error" role="alert">{{ 'ui.common.loadFailed' | t }}</div>
        } @else if (rows(); as r) {
          <div class="notice info">{{ (store.canEdit() ? 'ui.builder.translations.none' : 'ui.builder.viewOnly') | t }}</div>
          <section class="tr-body">
            <app-translations-grid
              [rows]="r"
              [filter]="store.filter()"
              [localeName]="localeName()"
              [editable]="store.canEdit() && !store.starting()"
              [live]="false"
              (entryChange)="store.start($event.path, $event.value)"
              (filterChange)="store.setFilter($event)" />
          </section>
        } @else {
          <p class="muted">{{ 'ui.common.loading' | t }}</p>
        }
      }
    </app-page-frame>
  `,
})
export class TranslationsScreen {
  readonly store = inject(TranslationsStore);
  readonly localeName = computed(() => languageName(this.store.locale()));
  readonly rows = computed(() => {
    const src = this.store.sources.sources(this.store.locale());
    return src ? translationRows(src, {}) : null;
  });
}
