import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output, type TemplateRef } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { ListLayout } from '../core/models';
import type { FilterPill } from '../core/records/record/present';
import type { RowView } from '../core/rows';
import type { ChipSpec } from '../core/records/spec';
import type { Sort } from '../core/records/list/url';
import { TranslatePipe } from '../services/i18n';
import { InfiniteScrollDirective } from './infinite-scroll';
import { AppliedFilterPills } from './filter-pills';
import { ChipFilterBar } from './chip-bar';
import { InfiniteListRow } from './card-rows';
import { ListFilterToolbar } from './list-toolbar';
import { LongPress } from './long-press';
import { TableRows, type TableColumn } from './table-rows';

/** Chips, search, pills, and the card or table rows with infinite scrolling, inside the list toolkit's panel. */
@Component({
  selector: 'app-filtered-infinite-list',
  imports: [ChipFilterBar, ListFilterToolbar, AppliedFilterPills, InfiniteListRow, TableRows, InfiniteScrollDirective, LongPress, NgTemplateOutlet, TranslatePipe],
  styleUrl: './styles/app-filtered-infinite-list.css',
  template: `
    <div class="filtered-infinite-list">
      <app-chip-filter-bar [chips]="chips()" [activeId]="activeChipId()" (chipSelect)="chipSelect.emit($event)"></app-chip-filter-bar>

      @if (toolbar()) {
        <app-list-filter-toolbar
          [searchText]="searchText()"
          [searchPlaceholder]="searchPlaceholder()"
          [filterCount]="appliedFilters().length"
          [sortOptions]="sortOptions()"
          [sort]="sort()"
          [layout]="layoutSwitch() ? layout() : null"
          [menuActions]="menuActions()"
          (searchChange)="searchChange.emit($event)"
          (sortToggle)="sortToggle.emit($event)"
          (filterOpen)="filterOpen.emit()"
          (layoutChange)="layoutChange.emit($event)"
          (menuAction)="menuAction.emit($event)">
        </app-list-filter-toolbar>
      }

      @if (appliedFilters().length) {
        <app-applied-filter-pills [filters]="appliedFilters()" (remove)="pillRemove.emit($event)"></app-applied-filter-pills>
      }

      <ng-content select="[listActions]"></ng-content>

      <div class="filtered-infinite-list__panel" [class.filtered-infinite-list__panel--refreshing]="refreshing()">
        @if (refreshing()) {
          <div class="filtered-infinite-list__refresh-bar" role="status" aria-live="polite">
            <span class="filtered-infinite-list__spinner filtered-infinite-list__spinner--sm" aria-hidden="true"></span>
            <span>{{ 'ui.common.updating' | t }}</span>
          </div>
        }

        @if (initialLoading()) {
          <div class="filtered-infinite-list__state filtered-infinite-list__state--initial">
            <span class="filtered-infinite-list__spinner" aria-hidden="true"></span>
            <span>{{ 'ui.common.loading' | t }}</span>
          </div>
        }

        @if (layout() === 'table') {
          @if (items().length) {
            <app-table-rows
              [rows]="items()"
              [columns]="columns()"
              [sort]="sort()"
              [selectedId]="selectedId()"
              [badgeKey]="badgeKey()"
              [inlineActions]="inlineActions()"
              [actionsDisabled]="actionsDisabled()"
              [checked]="selecting() ? checked() : null"
              (rowClick)="selecting() ? check.emit($event.id) : rowClick.emit($event)"
              (rowAction)="rowAction.emit($event)"
              (sortToggle)="sortToggle.emit($event)"
              (check)="check.emit($event)"
              (checkPage)="checkPage.emit()" />
          }
        } @else {
          @if (selecting() && items().length) {
            <div class="filtered-infinite-list__select-header">
              <button type="button" class="filtered-infinite-list__select-action" (click)="checkPage.emit()">{{ 'ui.bulk.selectAll' | t }}</button>
            </div>
          }
          @for (item of items(); track item.id) {
            @let ticked = !!checked()?.has(item.id);
            <div
              class="filtered-infinite-list__row"
              [class.filtered-infinite-list__row--selected]="item.id === selectedId() || ticked"
              [class.filtered-infinite-list__row--muted]="item.muted"
              [class.filtered-infinite-list__row--stacked]="inlineActions()"
              [attr.data-row-id]="item.id"
              (appLongPress)="checked() && rowLongPress.emit(item.id)">
              @if (selecting()) {
                <label class="filtered-infinite-list__row-check">
                  <input type="checkbox" [checked]="ticked" [attr.aria-label]="('ui.bulk.select' | t) + ' ' + item.title" (change)="check.emit(item.id)" />
                </label>
              }
              <button
                type="button"
                class="filtered-infinite-list__row-btn"
                [class.filtered-infinite-list__row-btn--selectable]="!!checked()"
                (click)="selecting() ? check.emit(item.id) : rowClick.emit(item)">
                <app-infinite-list-row [item]="item"></app-infinite-list-row>
              </button>
              @if (!selecting() && inlineActions() && item.actions.length) {
                <div class="filtered-infinite-list__row-actions">
                  @for (a of item.actions; track a.id) {
                    <button
                      type="button"
                      class="app-btn"
                      [class.app-btn--primary]="a.tone === 'primary'"
                      [class.danger]="a.tone === 'danger'"
                      [disabled]="actionsDisabled()"
                      (click)="rowAction.emit({ row: item, action: a.id })">
                      {{ a.label }}
                    </button>
                  }
                </div>
              } @else if (selecting() ? null : rowTrailing(); as tpl) {
                <div class="filtered-infinite-list__row-trailing" (click)="$event.stopPropagation()">
                  <ng-container [ngTemplateOutlet]="tpl" [ngTemplateOutletContext]="{ $implicit: item }"></ng-container>
                </div>
              }
            </div>
          }
        }

        @if (error()) {
          <div class="filtered-infinite-list__state filtered-infinite-list__state--inline" role="alert">
            <span>{{ error() }}</span>
            <button type="button" class="app-btn app-btn--primary" (click)="retry.emit()">{{ 'ui.common.retry' | t }}</button>
          </div>
        }

        @if (!items().length && !loading() && !error()) {
          <p class="filtered-infinite-list__empty">{{ emptyMessage() }}</p>
        }

        @if (loadingMore()) {
          <div class="filtered-infinite-list__state filtered-infinite-list__state--inline">
            <span class="filtered-infinite-list__spinner" aria-hidden="true"></span>
            <span>{{ 'ui.common.loadingMore' | t }}</span>
          </div>
        }

        @if (hasMore() && !loadingMore() && !error() && items().length) {
          <div appInfiniteScroll (visible)="loadMore.emit()" class="filtered-infinite-list__sentinel" aria-hidden="true"></div>
          <button type="button" class="filtered-infinite-list__load-more app-btn" (click)="loadMore.emit()">{{ 'ui.common.loadMore' | t }}</button>
        }

        @if (!hasMore() && !loading() && items().length) {
          <p class="filtered-infinite-list__end" [class.filtered-infinite-list__end--ruled]="layout() === 'table'">{{ 'ui.common.endOfList' | t }}</p>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .filtered-infinite-list__load-more {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
      .filtered-infinite-list__load-more:focus-visible {
        position: static;
        width: 100%;
        height: auto;
        clip: auto;
      }
      @media (prefers-reduced-motion: reduce) {
        .filtered-infinite-list__load-more {
          position: static;
          width: 100%;
          height: auto;
          clip: auto;
        }
      }
      .filtered-infinite-list__row--muted {
        opacity: 0.6;
      }
      .filtered-infinite-list__row--stacked {
        flex-direction: column;
      }
      .filtered-infinite-list__row-actions {
        display: flex;
        gap: 8px;
        padding: 0 10px 12px 56px;
      }
      .filtered-infinite-list__row-actions .app-btn {
        flex: 1;
      }
      .filtered-infinite-list__end {
        margin: 0;
        padding: 12px 16px;
        text-align: center;
        font-size: 0.68rem;
        color: var(--secondary-500);
      }
      .filtered-infinite-list__end--ruled {
        box-sizing: border-box;
        height: var(--table-row-height, 38px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding-top: 0;
        padding-bottom: 0;
        border-top: 1px solid var(--table-line, rgba(148, 163, 184, 0.32));
      }
    `,
  ],
})
export class FilteredInfiniteList {
  readonly chips = input.required<ChipSpec[]>();
  readonly activeChipId = input('');
  readonly items = input.required<RowView[]>();
  readonly loading = input(false);
  readonly loadingMore = input(false);
  readonly hasMore = input(false);
  readonly error = input('');
  readonly emptyMessage = input(t('ui.common.noItemsFound'));
  readonly searchText = input('');
  readonly searchPlaceholder = input('');
  readonly appliedFilters = input<FilterPill[]>([]);
  readonly sortOptions = input<{ key: string; label: string }[]>([]);
  readonly sort = input<Sort | undefined>();
  readonly selectedId = input<string | null>(null);
  readonly rowTrailing = input<TemplateRef<{ $implicit: RowView }> | null>(null);
  readonly layout = input<ListLayout>('cards');
  /** Whether the toolbar offers the Cards/Table switch. */
  readonly layoutSwitch = input(false);
  readonly columns = input<TableColumn[]>([]);
  readonly menuActions = input<{ id: string; label: string; disabled?: boolean }[]>([]);
  /** Whether the search, Sort and Filters toolbar shows. */
  readonly toolbar = input(true);
  /** Draws each row's actions as buttons, under the card or at the end of the table row, instead of a menu. */
  readonly inlineActions = input(false);
  readonly actionsDisabled = input(false);
  /** The table column whose cell shows the row's badge. */
  readonly badgeKey = input('status');
  /** The ticked rows when rows can be selected: tables get a checkbox column, cards a long-press. */
  readonly checked = input<ReadonlySet<string> | null>(null);
  /** Cards show checkboxes, and a tap ticks the row instead of opening it. */
  readonly selecting = input(false);
  readonly check = output<string>();
  readonly checkPage = output<void>();
  readonly rowLongPress = output<string>();
  readonly chipSelect = output<string>();
  readonly layoutChange = output<ListLayout>();
  readonly rowAction = output<{ row: RowView; action: string }>();
  readonly menuAction = output<string>();
  readonly loadMore = output<void>();
  readonly rowClick = output<RowView>();
  readonly filterOpen = output<void>();
  readonly searchChange = output<string>();
  readonly sortToggle = output<string>();
  readonly pillRemove = output<string>();
  readonly retry = output<void>();

  readonly initialLoading = computed(() => this.loading() && this.items().length === 0);
  readonly refreshing = computed(() => this.loading() && this.items().length > 0);
}
