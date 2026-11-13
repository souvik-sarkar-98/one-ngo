import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { FilteredInfiniteList } from '../../ui/filtered-infinite-list';
import { MobileFormSheet } from '../../ui/form-panel';
import { FilteredListPage } from '../../ui/list-page';
import { RowMenu } from '../../ui/row-menu';
import { ScreenHeading } from '../../ui/screen-heading';
import { JobsStore } from './jobs-store';

/** Background jobs: imports, bulk operations and rebuilds from everyone, with progress, failed items and Cancel. */
@Component({
  selector: 'app-admin-jobs',
  imports: [FilteredListPage, FilteredInfiniteList, MobileFormSheet, RowMenu, ScreenHeading, TranslatePipe, PageFrame],
  providers: [JobsStore],
  styleUrls: ['../../ui/styles/na-list-dashboard.css', '../admin.css'],
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.jobs' | t" />
      @let rows = store.rows();
      @let p = store.panel();
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      <section class="list-dashboard" [attr.aria-busy]="rows.loading">
        <app-filtered-list-page>
          <app-filtered-infinite-list
            [chips]="store.chips()"
            [activeChipId]="store.state().status"
            [items]="store.rowViews()"
            [loading]="rows.loading"
            [loadingMore]="rows.loadingMore"
            [hasMore]="rows.hasMore"
            [error]="rows.error"
            [searchText]="store.filterText()"
            [searchPlaceholder]="'ui.common.search' | t"
            [emptyMessage]="'ui.admin.empty' | t"
            [layout]="store.layout()"
            [columns]="store.columns()"
            [selectedId]="store.state().job ?? null"
            [rowTrailing]="rowTrailing"
            badgeKey="state"
            (chipSelect)="store.jobs.selectChip($event)"
            (searchChange)="store.filterText.set($event)"
            (loadMore)="store.jobs.loadMore()"
            (retry)="store.jobs.controller.retry()"
            (rowAction)="store.rowAction($event.row.id, $event.action)"
            (rowClick)="store.jobs.open($event.id)">
          </app-filtered-infinite-list>
        </app-filtered-list-page>
        <ng-template #rowTrailing let-row>
          @if (row.actions.length) {
            <app-row-menu [actions]="row.actions" (choose)="store.rowAction(row.id, $event)" />
          }
        </ng-template>
      </section>

      <app-mobile-form-sheet [open]="!!store.state().job" [title]="p.job?.label ?? p.job?.kind ?? ''" [showDefaultFooter]="false" (dismissed)="store.jobs.close()">
        @if (p.error) {
          <div class="notice error" role="alert">{{ p.error }}</div>
        }
        @if (p.job; as j) {
          <div class="admin__kv">
            <b>{{ 'ui.admin.jobs.col.started' | t }}</b><span>{{ j.createdByName ?? j.createdBy }}</span>
            <b>{{ 'ui.admin.jobs.col.progress' | t }}</b><span>{{ store.progress() }}</span>
            <b>{{ 'ui.admin.jobs.col.state' | t }}</b><span>{{ 'ui.admin.jobs.status.' + j.status | t }}</span>
          </div>
          @if (j.error) {
            <div class="admin__problem">{{ j.error }}</div>
          }
          @if (j.total) {
            <div class="admin__bar"><i [style.width.%]="(j.progress / j.total) * 100"></i></div>
          }
        }
        @if (p.loading) {
          <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
        } @else if (p.job) {
          <h3 class="admin__caption">{{ 'ui.admin.jobs.failedItems' | t }}</h3>
          @for (i of p.failed; track i.seq) {
            <div class="admin__problem"><b>{{ i.recordId ?? ('ui.admin.jobs.item' | t: { seq: i.seq }) }}</b> · {{ i.message }}</div>
          } @empty {
            <p class="muted">{{ 'ui.admin.jobs.noFailed' | t }}</p>
          }
          @if (p.failed.length) {
            <button type="button" class="app-btn" (click)="store.download()">{{ 'ui.imports.downloadFailed' | t }}</button>
          }
        }
        <button sheetFooterActions type="button" class="app-btn" (click)="store.jobs.close()">{{ 'ui.common.close' | t }}</button>
        @if (store.running()) {
          <button sheetFooterActions type="button" class="app-btn danger" [disabled]="p.busy" (click)="store.cancelOpen()">{{ 'ui.admin.jobs.cancel' | t }}</button>
        }
      </app-mobile-form-sheet>
    </app-page-frame>
  `,
})
export class JobsScreen {
  readonly store = inject(JobsStore);
}
