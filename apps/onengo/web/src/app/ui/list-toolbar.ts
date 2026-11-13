import { Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import type { ListLayout } from '../core/models';
import type { Sort } from '../core/records/list/url';
import { TranslatePipe } from '../services/i18n';

@Component({
  selector: 'app-list-filter-toolbar',
  imports: [MatMenuModule, MatIconModule, TranslatePipe],
  styleUrl: './styles/app-list-filter-toolbar.css',
  template: `
    <div class="list-filter-toolbar">
      <div class="list-filter-toolbar__search">
        <svg class="list-filter-toolbar__search-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
        <input
          type="search"
          class="list-filter-toolbar__input"
          [value]="searchText()"
          [placeholder]="searchPlaceholder()"
          (input)="searchChange.emit($any($event.target).value)"
          [attr.aria-label]="'ui.records.searchList' | t">
      </div>

      @if (layout(); as current) {
        <div class="list-filter-toolbar__layout" role="group" [attr.aria-label]="'ui.records.layout' | t">
          <button type="button" class="list-filter-toolbar__filters-btn" [attr.aria-pressed]="current === 'cards'" (click)="pick('cards')">
            <svg class="list-filter-toolbar__filters-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 5h18v6H3V5zm0 8h18v6H3v-6z"/>
            </svg>
            <span class="list-filter-toolbar__filters-label">{{ 'ui.records.cards' | t }}</span>
          </button>
          <button type="button" class="list-filter-toolbar__filters-btn" [attr.aria-pressed]="current === 'table'" (click)="pick('table')">
            <svg class="list-filter-toolbar__filters-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 4h18v4H3V4zm0 6h18v4H3v-4zm0 6h18v4H3v-4z"/>
            </svg>
            <span class="list-filter-toolbar__filters-label">{{ 'ui.records.table' | t }}</span>
          </button>
        </div>
      }

      @if (sortOptions().length) {
        <button type="button" class="list-filter-toolbar__filters-btn" [matMenuTriggerFor]="sortMenu" [attr.aria-label]="'ui.common.sort' | t">
          <svg class="list-filter-toolbar__filters-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/>
          </svg>
          <span class="list-filter-toolbar__filters-label">{{ 'ui.common.sort' | t }}</span>
          @if (sort()) {
            <span class="list-filter-toolbar__badge">{{ sort()!.dir === 'asc' ? '▲' : '▼' }}</span>
          }
        </button>
        <mat-menu #sortMenu="matMenu" xPosition="before">
          @for (o of sortOptions(); track o.key) {
            <button type="button" mat-menu-item [attr.aria-pressed]="sort()?.field === o.key" (click)="sortToggle.emit(o.key)">
              <span>{{ o.label }} @if (sort()?.field === o.key) { {{ sort()!.dir === 'asc' ? '▲' : '▼' }} }</span>
            </button>
          }
        </mat-menu>
      }

      <button
        type="button"
        class="list-filter-toolbar__filters-btn"
        (click)="filterOpen.emit()"
        [attr.aria-label]="'ui.records.openFilters' | t">
        <svg class="list-filter-toolbar__filters-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/>
        </svg>
        <span class="list-filter-toolbar__filters-label">{{ 'ui.common.filters' | t }}</span>
        @if (filterCount() > 0) {
          <span class="list-filter-toolbar__badge">{{ filterCount() }}</span>
        }
      </button>

      @if (menuActions().length) {
        <button type="button" class="list-filter-toolbar__filters-btn" [matMenuTriggerFor]="listMenu" [attr.aria-label]="'ui.common.moreActions' | t">
          <mat-icon>more_vert</mat-icon>
        </button>
        <mat-menu #listMenu="matMenu" xPosition="before">
          @for (a of menuActions(); track a.id) {
            <button type="button" mat-menu-item [disabled]="!!a.disabled" (click)="menuAction.emit(a.id)">
              <span>{{ a.label }}</span>
            </button>
          }
        </mat-menu>
      }
    </div>
  `,
  styles: [
    `
      .list-filter-toolbar__layout {
        display: inline-flex;
        flex: 0 0 auto;
        overflow: hidden;
        border: 1px solid var(--search-border, rgba(148, 163, 184, 0.35));
        border-radius: var(--search-radius, 12px);
        background: #fff;
      }
      .list-filter-toolbar__layout .list-filter-toolbar__filters-btn {
        border: 0;
        border-radius: 0;
      }
      .list-filter-toolbar__layout .list-filter-toolbar__filters-icon {
        display: none;
      }
      .list-filter-toolbar__layout .list-filter-toolbar__filters-btn[aria-pressed='true'] {
        background: var(--section-bg, var(--primary-50));
        color: var(--brand, var(--primary-700));
      }
      .list-filter-toolbar__filters-btn[aria-pressed='true'] {
        border-color: var(--primary-200);
        color: var(--primary-700);
        background: var(--primary-50);
      }
    `,
  ],
})
export class ListFilterToolbar {
  readonly searchText = input('');
  readonly searchPlaceholder = input('');
  readonly filterCount = input(0);
  readonly sortOptions = input<{ key: string; label: string }[]>([]);
  readonly sort = input<Sort | undefined>();
  /** The Cards/Table switch shows the current layout; null hides it (phones always use cards). */
  readonly layout = input<ListLayout | null>(null);
  /** Entries of the list's ⋮ menu; the menu is hidden while there are none. */
  readonly menuActions = input<{ id: string; label: string; disabled?: boolean }[]>([]);
  readonly searchChange = output<string>();
  readonly filterOpen = output<void>();
  readonly sortToggle = output<string>();
  readonly layoutChange = output<ListLayout>();
  readonly menuAction = output<string>();

  pick(layout: ListLayout): void {
    if (layout !== this.layout()) this.layoutChange.emit(layout);
  }
}
