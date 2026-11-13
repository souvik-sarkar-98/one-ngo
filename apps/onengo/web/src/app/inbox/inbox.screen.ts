import { Component, computed, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { t } from '../core/i18n/i18n';
import type { CfFieldDef } from '../ui/cf-types';
import { TranslatePipe } from '../services/i18n';
import { ListFilterSheet } from '../ui/filter-panel';
import { FilteredInfiniteList } from '../ui/filtered-infinite-list';
import { MobileFormSheet } from '../ui/form-panel';
import { FilteredListPage } from '../ui/list-page';
import { ScreenHeading } from '../ui/screen-heading';
import { InboxStore } from './inbox-store';

/**
 * The Inbox (Design §7): chips Approvals and Notifications. Approvals work
 * like a record list — search, Sort, Filters and pills, cards on phones and a
 * table wider, Approve and Reject on every row, Reject asking for a reason in
 * a panel. Notifications are cards, newest first, with Mark all read. The
 * store holds the state; this component only draws.
 */
@Component({
  selector: 'app-inbox-screen',
  imports: [FilteredListPage, FilteredInfiniteList, ListFilterSheet, MobileFormSheet, ScreenHeading, TranslatePipe, PageFrame],
  providers: [InboxStore],
  styleUrl: '../ui/styles/na-list-dashboard.css',
  styles: `
    .inbox__actions {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 10px;
    }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.nav.inbox' | t" />
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" [class.info]="n.level === 'info'" role="status">
          {{ n.message }}
        </div>
      }
      <section class="list-dashboard">
        <app-filtered-list-page>
          @if (store.tab() === 'approvals') {
            @let rows = store.rows();
            <app-filtered-infinite-list
              [attr.aria-busy]="rows.loading"
              [chips]="store.chips()"
              activeChipId="approvals"
              [items]="store.approvalRows()"
              [loading]="rows.loading"
              [loadingMore]="rows.loadingMore"
              [hasMore]="rows.hasMore"
              [error]="rows.error"
              [searchText]="store.search.text()"
              [searchPlaceholder]="'ui.inbox.searchApprovals' | t"
              [appliedFilters]="store.pills()"
              [sortOptions]="store.sortOptions()"
              [sort]="store.sort()"
              [emptyMessage]="'ui.inbox.nothingWaiting' | t"
              [layout]="store.layout()"
              [columns]="store.columns()"
              badgeKey="approvals"
              [inlineActions]="true"
              [actionsDisabled]="store.deciding()"
              (chipSelect)="store.selectTab($event)"
              (searchChange)="store.search.input($event)"
              (sortToggle)="store.toggleSort($event)"
              (filterOpen)="store.openFilters()"
              (pillRemove)="store.removeFilter($event)"
              (loadMore)="store.loadMore()"
              (retry)="store.retry()"
              (rowAction)="store.rowAction($event.row.id, $event.action)"
              (rowClick)="store.openApproval($event.id)">
            </app-filtered-infinite-list>

            <app-list-filter-sheet
              [open]="store.filtersOpen()"
              [title]="'ui.inbox.filtersTitle' | t"
              [fields]="filterFields()"
              [initialValues]="store.filterValues()"
              (closed)="store.closeFilters()"
              (applied)="store.applyFilters($event)"
              (reset)="store.clearFilters()">
            </app-list-filter-sheet>
          } @else if (store.tab() === 'notifications') {
            @let feed = store.notifications();
            <app-filtered-infinite-list
              [attr.aria-busy]="feed.loading"
              [chips]="store.chips()"
              activeChipId="notifications"
              [toolbar]="false"
              [items]="store.notificationRows()"
              [loading]="feed.loading"
              [loadingMore]="feed.loadingMore"
              [hasMore]="feed.hasMore"
              [error]="feed.error"
              [emptyMessage]="'ui.inbox.noNotifications' | t"
              (chipSelect)="store.selectTab($event)"
              (loadMore)="store.loadMoreNotifications()"
              (retry)="store.retryNotifications()"
              (rowClick)="store.openNotification($event.id)">
              <div listActions class="inbox__actions">
                <button type="button" class="app-btn" [disabled]="!store.hasUnread()" (click)="store.markAllRead()">{{ 'ui.inbox.markAllRead' | t }}</button>
              </div>
            </app-filtered-infinite-list>
          } @else {
            <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
          }
        </app-filtered-list-page>

        <app-mobile-form-sheet
          [open]="!!store.rejecting()"
          [title]="rejectTitle()"
          [saving]="store.deciding()"
          [saveLabel]="'ui.common.reject' | t"
          (dismissed)="store.cancelReject()"
          (save)="store.confirmReject()">
          <div class="field">
            <label for="reject-reason">{{ 'ui.inbox.rejectReason' | t }}</label>
            <textarea id="reject-reason" rows="3" [value]="store.reason()" (input)="store.reason.set($any($event.target).value)"></textarea>
          </div>
        </app-mobile-form-sheet>
      </section>
    </app-page-frame>
  `,
})
export class InboxScreen {
  readonly store = inject(InboxStore);

  readonly filterFields = computed<CfFieldDef[]>(() =>
    this.store.filters().map((f) => ({ key: f.key, label: f.label, type: 'multiselect', required: false, readOnly: false, options: f.options })),
  );
  readonly rejectTitle = computed(() => {
    const a = this.store.rejecting();
    return a ? t('ui.inbox.rejectTitle', { step: a.stepLabel }) : '';
  });
}
