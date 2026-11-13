import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { lowerLabel } from '../core/i18n/i18n';
import { permits } from '../core/records/import/import-session';
import type { FormValues } from '../core/records/record/forms';
import { labelOf, resolveListSpec } from '../core/records/spec';
import { I18n, TranslatePipe } from '../services/i18n';
import { Session } from '../services/session';
import { filterFields } from '../ui/cf-types';
import { CreateButton } from '../ui/create-button';
import { ListFilterSheet } from '../ui/filter-panel';
import { FilteredInfiniteList } from '../ui/filtered-infinite-list';
import { FilteredListPage } from '../ui/list-page';
import { RowMenu } from '../ui/row-menu';
import { ScreenHeading } from '../ui/screen-heading';
import { BulkBar } from './bulk-bar';
import { BulkPanel } from './bulk-panel';
import { BulkStore } from './bulk-store';
import { criteriaToSheetValues, sheetValuesToCriteria } from './filter-draft';
import { ImportPanel } from './import-panel';
import { ImportStore } from './import-store';
import { ListStore } from './list-store';
import type { Notice } from './notice';
import { RecordPanel } from './record-panel';
import { RecordStore } from './record-store';

/**
 * The one record list screen, for every record type and every size: chips,
 * toolbar, pills, card or table rows, infinite scrolling, the create button,
 * the filters panel and the record panel. Phones always get cards. The list
 * comes from the list store and the open record from the record store; this
 * component only draws.
 */
@Component({
  selector: 'app-record-list-screen',
  imports: [FilteredListPage, FilteredInfiniteList, ListFilterSheet, RecordPanel, ImportPanel, BulkBar, BulkPanel, RowMenu, CreateButton, ScreenHeading, TranslatePipe, PageFrame],
  providers: [ListStore, RecordStore, ImportStore, BulkStore],
  styleUrls: ['../ui/styles/na-list-dashboard.css', '../ui/styles/title-action.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="heading()" />
        @if (store.canCreate() && !store.narrow() && !bulk.showBar()) {
          <button type="button" class="app-btn app-btn--primary admin__title-action" (click)="store.intents.openCreate()">{{ createLabel() }}</button>
        }
      </div>
      @if (store.spec(); as spec) {
        @let state = store.state()!;
        @let rows = store.rows();
        @if (notice(); as n) {
          <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" [class.info]="n.level === 'info'" role="status">
            {{ n.message }}
          </div>
        }
        <section class="list-dashboard" [attr.aria-busy]="rows.loading">
          <app-filtered-list-page>
            <app-filtered-infinite-list
              [chips]="spec.chips"
              [activeChipId]="state.chip"
              [items]="store.rowViews()"
              [loading]="rows.loading"
              [loadingMore]="rows.loadingMore"
              [hasMore]="rows.hasMore"
              [error]="rows.error"
              [searchText]="store.search.text()"
              [searchPlaceholder]="spec.searchPlaceholder"
              [appliedFilters]="store.pills()"
              [sortOptions]="sortOptions()"
              [sort]="state.sort"
              [emptyMessage]="spec.emptyMessage"
              [selectedId]="store.lastOpened()"
              [rowTrailing]="store.hasRowActions() ? rowTrailing : null"
              [layout]="store.view()"
              [layoutSwitch]="!store.narrow()"
              [columns]="store.columns()"
              [menuActions]="menu()"
              [checked]="bulk.checked()"
              [selecting]="bulk.selecting()"
              (menuAction)="bulk.chooseMenu($event) || store.chooseMenu($event)"
              (check)="bulk.check($event)"
              (checkPage)="bulk.checkPage()"
              (rowLongPress)="bulk.press($event)"
              (chipSelect)="store.intents.selectChip($event)"
              (searchChange)="store.search.input($event)"
              (sortToggle)="store.intents.toggleSort($event)"
              (filterOpen)="store.intents.openFilters()"
              (pillRemove)="store.intents.removeFilter($event)"
              (loadMore)="store.intents.loadMore()"
              (retry)="store.intents.retry()"
              (layoutChange)="store.intents.setView($event)"
              (rowAction)="store.runRowAction($event.row.id, $event.action)"
              (rowClick)="store.intents.open($event.id)">
            </app-filtered-infinite-list>

            <app-list-filter-sheet
              [open]="state.filtersOpen"
              [title]="spec.filterSheetTitle"
              [fields]="filterFieldDefs()"
              [initialValues]="filterValues()"
              (closed)="store.intents.closeFilters()"
              (applied)="applyFilters($event)"
              (reset)="store.intents.clearFilters()">
            </app-list-filter-sheet>
          </app-filtered-list-page>

          <ng-template #rowTrailing let-row>
            @if (row.actions.length) {
              <app-row-menu [actions]="row.actions" (choose)="store.runRowAction(row.id, $event)" />
            }
          </ng-template>

          @if (bulk.showBar() || (store.canCreate() && store.narrow())) {
            <div class="list-dashboard__floating-actions">
              @if (bulk.showBar()) {
                <app-bulk-bar />
              } @else {
                <app-create-button [label]="createLabel()" (pressed)="store.intents.openCreate()" />
              }
            </div>
          }

          <app-record-panel />
          <app-bulk-panel />
          @if (state.import) {
            <app-import-panel />
          }
        </section>
      } @else {
        <div class="notice error">{{ 'ui.records.notFound' | t }}</div>
      }
    </app-page-frame>
  `,
})
export class RecordListScreen {
  readonly store = inject(ListStore);
  readonly rec = inject(RecordStore);
  readonly bulk = inject(BulkStore);
  private readonly transfers = inject(ImportStore);
  private readonly session = inject(Session);
  private readonly i18n = inject(I18n);
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  readonly type = input.required<string>();
  readonly notice = signal<Notice | null>(null);
  readonly heading = computed(() => this.spec()?.title ?? '');

  private readonly spec = computed(() => {
    const type = this.session.recordType(this.type());
    if (!type) return null;
    return resolveListSpec(type, this.session.workflow(type.key), this.session.defs()?.listViews?.[type.key], {
      workflows: this.session.workflows(type.key),
      actions: this.session.actions(type.key),
      startingLayout: this.session.defs()?.listLayout,
      canImport: permits(this.session.me()?.permissions ?? [], `record:${type.key}:import`),
    });
  });

  readonly sortOptions = computed(() => {
    const spec = this.store.spec()!;
    return spec.sortable.map((key) => ({ key, label: labelOf(spec.type, key) }));
  });
  readonly filterFieldDefs = computed(() => filterFields(this.store.spec()!.filters));
  readonly filterValues = computed(() => criteriaToSheetValues(this.store.spec()!.filters, this.store.state()!.criteria));
  /** The list's ⋮: Select first, then import and export. */
  readonly menu = computed(() => [...this.bulk.menu(), ...this.store.listMenu()]);
  readonly createLabel = computed(() => this.i18n.t('ui.records.new', { type: lowerLabel(this.store.spec()!.type.label) }));

  constructor() {
    effect(() => {
      const spec = this.spec();
      untracked(() => (spec ? this.store.use(spec) : this.store.spec.set(null)));
    });
    let shown = '';
    effect(() => {
      const r = this.rec.snapshot();
      const failure = this.rec.failure();
      const done = this.rec.completed();
      // A save that fails inside a form sheet is shown in that sheet, not on the page behind it.
      const s = this.store.state();
      const inForm = !!s && (!!s.create || ['edit', 'step', 'action'].includes(s.panel.kind));
      // A record open in its sheet says what happened there too, so the page behind stays quiet.
      const inSheet = !!s && !s.create && !!r?.record && ['view', 'edit', 'step', 'action'].includes(s.panel.kind);
      const n: Notice | null = r?.message
        ? inSheet
          ? null
          : { level: 'success', message: r.message }
        : r?.error && !inForm && !inSheet
          ? { level: 'error', message: r.error }
          : failure;
      const key = n ? `${n.level}:${n.message}:${r?.record?.version ?? ''}:${done?.count ?? ''}` : '';
      if (n && key !== shown) untracked(() => this.show(n));
      shown = key;
    });
    effect(() => {
      const n = this.transfers.notice();
      if (n) untracked(() => this.show(n));
    });
    effect(() => {
      const n = this.store.pinNotice();
      if (n) untracked(() => this.show(n));
    });
  }

  applyFilters(values: FormValues): void {
    this.store.intents.applyFilters(sheetValuesToCriteria(this.store.spec()!.filters, values));
  }

  private show(n: Notice): void {
    this.notice.set(n);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), n.level === 'error' ? 8000 : 4000);
  }
}
