import { Component, computed, input, signal } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { DetailSection } from '../core/records/record/present';
import type { RowView } from '../core/rows';
import { InfiniteListRow } from './card-rows';
import { ChipFilterBar } from './chip-bar';
import { withDefaults } from './labels';
import { ListDetailSections } from './panel';

const LABELS = () => ({
  list: t('ui.livePreview.list'),
  panel: t('ui.livePreview.panel'),
  empty: t('ui.livePreview.empty'),
  noSteps: t('ui.livePreview.noSteps'),
});

/**
 * A small phone-sized frame drawing the real list rows and record panel
 * sections from a model worked out elsewhere, such as a draft or a role's
 * view of the records. Nothing in it can be pressed.
 */
@Component({
  selector: 'app-role-preview',
  imports: [ChipFilterBar, InfiniteListRow, ListDetailSections],
  template: `
    <app-chip-filter-bar [chips]="tabs()" [activeId]="tab()" (chipSelect)="tab.set($any($event))" />
    <div class="live-preview" inert>
      <div class="live-preview__bar">
        <span>{{ tab() === 'list' ? title() : panelTitle() }}</span>
        @if (tab() === 'list' && canCreate()) { <span aria-hidden="true">+</span> }
      </div>
      @if (tab() === 'list') {
        @if (chips().length) {
          <div class="live-preview__chips">@for (c of chips(); track c.id) { <span class="chip">{{ c.label }}</span> }</div>
        }
        @for (r of rows(); track r.id) { <app-infinite-list-row [item]="r" /> } @empty { <p class="muted">{{ labels().empty }}</p> }
      } @else {
        <app-list-detail-sections [sections]="sections()" />
        <div class="live-preview__steps">
          @for (s of steps(); track $index) { <span class="chip">{{ s }}</span> } @empty { <span class="muted">{{ labels().noSteps }}</span> }
        </div>
      }
    </div>
    @if (note()) { <p class="muted live-preview__note">{{ note() }}</p> }
  `,
  styles: `
    :host { display: block; }
    .live-preview { border: 1px solid var(--line); border-radius: calc(var(--radius) * 2); background: var(--bg, var(--card)); max-width: 360px; overflow: hidden; margin-top: .5rem; }
    .live-preview__bar { display: flex; justify-content: space-between; padding: .6rem .8rem; background: var(--brand); color: var(--brand-fg, #fff); font-weight: 600; }
    .live-preview__chips, .live-preview__steps { display: flex; flex-wrap: wrap; gap: .35rem; padding: .5rem .6rem; }
    .live-preview__note { font-size: .85rem; margin-top: .4rem; }
  `,
})
export class RolePreview {
  readonly title = input('');
  readonly chips = input<{ id: string; label: string }[]>([]);
  readonly rows = input<RowView[]>([]);
  readonly canCreate = input(false);
  readonly panelTitle = input('');
  readonly sections = input<DetailSection[]>([]);
  readonly steps = input<string[]>([]);
  readonly note = input('');
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  readonly tab = signal<'list' | 'panel'>('list');
  readonly tabs = computed(() => [
    { id: 'list', label: this.labels().list },
    { id: 'panel', label: this.labels().panel },
  ]);
}
