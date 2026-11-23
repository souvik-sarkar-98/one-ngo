import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { binName } from '../../core/admin/recycle-bin';
import { TranslatePipe } from '../../services/i18n';
import { FilteredInfiniteList } from '../../ui/filtered-infinite-list';
import { MobileFormSheet } from '../../ui/form-panel';
import { FilteredListPage } from '../../ui/list-page';
import { RowMenu } from '../../ui/row-menu';
import { ScreenHeading } from '../../ui/screen-heading';
import { RecycleBinStore } from './recycle-bin-store';

/** The recycle bin: records an administrator deleted, newest first; Restore puts one back as it was. */
@Component({
  selector: 'app-admin-recycle-bin',
  imports: [FilteredListPage, FilteredInfiniteList, MobileFormSheet, RowMenu, ScreenHeading, TranslatePipe, PageFrame],
  providers: [RecycleBinStore],
  styleUrls: ['../../ui/styles/na-list-dashboard.css', '../admin.css'],
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.recordBin' | t" />
      @let s = store.state();
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      <p class="notice info">{{ 'ui.admin.bin.note' | t }}</p>
      <section class="list-dashboard" [attr.aria-busy]="s.loading">
        <app-filtered-list-page>
          <app-filtered-infinite-list
            [chips]="[]"
            [items]="store.rows()"
            [loading]="s.loading"
            [loadingMore]="s.loadingMore"
            [hasMore]="store.hasMore()"
            [error]="s.error"
            [searchText]="store.filterText()"
            [searchPlaceholder]="'ui.admin.bin.search' | t"
            [emptyMessage]="'ui.admin.bin.empty' | t"
            [layout]="store.layout()"
            [columns]="store.columns()"
            [rowTrailing]="rowTrailing"
            (searchChange)="store.search($event)"
            (loadMore)="store.bin.loadMore()"
            (retry)="store.bin.load()"
            (rowAction)="store.rowAction($event.row.id, $event.action)">
          </app-filtered-infinite-list>
        </app-filtered-list-page>
        <ng-template #rowTrailing let-row>
          @if (row.actions.length) {
            <app-row-menu [actions]="row.actions" (choose)="store.rowAction(row.id, $event)" />
          }
        </ng-template>
      </section>

      <app-mobile-form-sheet
        [open]="!!s.restoring"
        [title]="'ui.admin.bin.restoreTitle' | t: { name: s.restoring ? name(s.restoring) : '' }"
        [saving]="s.busy"
        [error]="s.restoreError"
        [saveLabel]="'ui.admin.bin.restore' | t"
        (dismissed)="store.bin.cancelRestore()"
        (save)="store.confirmRestore()">
        <p>{{ 'ui.admin.bin.restoreNote' | t }}</p>
      </app-mobile-form-sheet>
    </app-page-frame>
  `,
})
export class RecycleBinScreen {
  readonly store = inject(RecycleBinStore);
  readonly name = binName;
}
