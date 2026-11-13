import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { ListFilterSheet } from '../../ui/filter-panel';
import { FilteredInfiniteList } from '../../ui/filtered-infinite-list';
import { FilteredListPage } from '../../ui/list-page';
import { ScreenHeading } from '../../ui/screen-heading';
import { AuditStore } from './audit-store';

/** The audit log: read-only, newest first, with filters by person (including API keys), area, record type and date. */
@Component({
  selector: 'app-admin-audit',
  imports: [FilteredListPage, FilteredInfiniteList, ListFilterSheet, ScreenHeading, TranslatePipe, PageFrame],
  providers: [AuditStore],
  styleUrl: '../../ui/styles/na-list-dashboard.css',
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.audit' | t" />
      @let rows = store.rows();
      <section class="list-dashboard" [attr.aria-busy]="rows.loading">
        <app-filtered-list-page>
          <app-filtered-infinite-list
            [chips]="[]"
            [items]="store.rowViews()"
            [loading]="rows.loading"
            [loadingMore]="rows.loadingMore"
            [hasMore]="rows.hasMore"
            [error]="rows.error"
            [searchText]="store.filterText()"
            [searchPlaceholder]="'ui.common.search' | t"
            [appliedFilters]="store.pills()"
            [emptyMessage]="'ui.admin.empty' | t"
            [layout]="store.layout()"
            [columns]="store.columns()"
            badgeKey="area"
            (searchChange)="store.filterText.set($event)"
            (filterOpen)="store.filtersOpen.set(true)"
            (pillRemove)="store.audit.removeFilter($event)"
            (loadMore)="store.audit.loadMore()"
            (retry)="store.audit.controller.retry()"
            (rowClick)="store.open($event.id)">
          </app-filtered-infinite-list>
          <app-list-filter-sheet
            [open]="store.filtersOpen()"
            [fields]="store.filterFields()"
            [initialValues]="store.filterValues()"
            (closed)="store.filtersOpen.set(false)"
            (applied)="store.applyFilters($event)"
            (reset)="store.clearFilters()">
          </app-list-filter-sheet>
        </app-filtered-list-page>
      </section>
    </app-page-frame>
  `,
})
export class AuditScreen {
  readonly store = inject(AuditStore);
}
