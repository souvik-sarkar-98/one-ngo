import { Component, computed, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { t } from '../core/i18n/i18n';
import { TranslatePipe } from '../services/i18n';
import { Autocomplete } from '../ui/autocomplete';
import { CreateButton } from '../ui/create-button';
import { ListFilterSheet } from '../ui/filter-panel';
import { FilteredInfiniteList } from '../ui/filtered-infinite-list';
import { MobileFormSheet } from '../ui/form-panel';
import { FilteredListPage } from '../ui/list-page';
import { ListDetailSheet } from '../ui/panel';
import { RowMenu } from '../ui/row-menu';
import { ScreenHeading } from '../ui/screen-heading';
import { PeopleStore } from './people-store';

/**
 * Administration → People. Search, status, roles, Add a person, and the
 * person panel (invite, suspend, reactivate). The store holds the state;
 * this component only draws.
 */
@Component({
  selector: 'app-people-screen',
  imports: [FilteredListPage, FilteredInfiniteList, ListFilterSheet, ListDetailSheet, MobileFormSheet, Autocomplete, RowMenu, CreateButton, ScreenHeading, TranslatePipe, PageFrame],
  providers: [PeopleStore],
  styleUrls: ['../ui/styles/na-list-dashboard.css', '../ui/styles/app-filtered-infinite-list.css', '../ui/styles/title-action.css'],
  styles: `
    .people__required { color: #f97316; }
    .people__head {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-bottom: 12px;
    }
    .people__name {
      font-weight: 600;
    }
    .people__roles {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 6px 0 10px;
    }
    .people__role {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 4px 2px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-size: 0.8rem;
    }
    .people__role button {
      border: 0;
      background: transparent;
      cursor: pointer;
      font: inherit;
      padding: 0 6px;
    }
    .people__check {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      margin: 12px 0;
    }
    .people__section {
      margin: 12px 0 6px;
      font-weight: 600;
      font-size: 0.85rem;
    }
    .people__bulk {
      margin-bottom: 0;
      flex-wrap: wrap;
    }
  `,
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="'ui.crumbs.people' | t" />
        @if (store.manages && !store.narrow() && !store.selectedCount() && !store.selecting()) {
          <button type="button" class="app-btn app-btn--primary admin__title-action" (click)="store.openAdd()">{{ 'ui.crumbs.addPerson' | t }}</button>
        }
      </div>
      @let rows = store.rows();
      @let state = store.state();
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      <section class="list-dashboard" [attr.aria-busy]="rows.loading">
        <app-filtered-list-page>
          <app-filtered-infinite-list
            [chips]="store.chips()"
            [activeChipId]="state.status"
            [items]="store.rowViews()"
            [loading]="rows.loading"
            [loadingMore]="rows.loadingMore"
            [hasMore]="rows.hasMore"
            [error]="rows.error"
            [searchText]="store.search.text()"
            [searchPlaceholder]="'ui.people.search' | t"
            [appliedFilters]="store.pills()"
            [sortOptions]="store.sortOptions()"
            [sort]="store.sort()"
            [emptyMessage]="'ui.people.empty' | t"
            [selectedId]="store.highlight() ?? state.person ?? null"
            [rowTrailing]="store.manages ? rowTrailing : null"
            [layout]="store.layout()"
            [columns]="store.columns()"
            [menuActions]="store.listMenu()"
            [checked]="store.checked()"
            [selecting]="store.selecting()"
            (menuAction)="store.chooseMenu($event)"
            (check)="store.check($event)"
            (checkPage)="store.checkPage()"
            (rowLongPress)="store.press($event)"
            (chipSelect)="store.selectChip($event)"
            (searchChange)="store.search.input($event)"
            (sortToggle)="store.toggleSort($event)"
            (filterOpen)="store.openFilters()"
            (pillRemove)="store.removeFilter($event)"
            (loadMore)="store.loadMore()"
            (retry)="store.retry()"
            (rowAction)="store.rowAction($event.row.id, $event.action)"
            (rowClick)="store.open($event.id)">
          </app-filtered-infinite-list>

          <app-list-filter-sheet
            [open]="store.filtersOpen()"
            [fields]="store.filterFields()"
            [initialValues]="store.filterValues()"
            (closed)="store.closeFilters()"
            (applied)="store.applyFilters($event)"
            (reset)="store.clearFilters()">
          </app-list-filter-sheet>
        </app-filtered-list-page>

        <ng-template #rowTrailing let-row>
          @if (row.actions.length) {
            <app-row-menu [actions]="row.actions" (choose)="store.rowAction(row.id, $event)" />
          }
        </ng-template>

        @if (store.manages && (store.selectedCount() || store.selecting() || store.narrow())) {
          <div class="list-dashboard__floating-actions">
            @if (store.selectedCount() || store.selecting()) {
              <div class="filtered-infinite-list__bulk-bar people__bulk" role="region" [attr.aria-label]="'ui.bulk.selected' | t: { count: store.selectedCount() }">
                <div class="filtered-infinite-list__bulk-meta">
                  <button type="button" class="filtered-infinite-list__bulk-clear" [attr.aria-label]="'ui.bulk.clear' | t" (click)="store.clearSelection()">✕</button>
                  <span class="filtered-infinite-list__bulk-count" aria-live="polite">{{ 'ui.bulk.selected' | t: { count: store.selectedCount() } }}</span>
                </div>
                @if (store.selectedCount()) {
                  <div class="filtered-infinite-list__bulk-actions">
                    @for (op of bulkShown(); track op.id) {
                      <button type="button" class="app-btn" [class.app-btn--primary]="$first" [disabled]="store.busy()" (click)="store.openBulk(op.id)">{{ op.label }}</button>
                    }
                    @if (bulkRest().length) {
                      <app-row-menu [actions]="bulkRest()" (choose)="store.openBulk($event)" />
                    }
                  </div>
                }
              </div>
            } @else if (store.narrow()) {
              <app-create-button [label]="'ui.crumbs.addPerson' | t" (pressed)="store.openAdd()" />
            }
          </div>
        }

        <app-list-detail-sheet
          [open]="!!state.person"
          [mode]="'view'"
          [title]="store.personTitle()"
          [sections]="store.sections()"
          [loading]="!store.person() && !store.personError()"
          [saving]="store.busy()"
          [hasFooterActions]="store.manages && !!store.person()"
          [notice]="store.panelNotice()"
          [viewError]="store.panelError()"
          (closed)="store.close()">
          <div detailHero>
            @if (store.personError()) {
              <div class="notice error" role="alert">{{ store.personError() }}</div>
            }
            @if (store.person(); as p) {
              <div class="people__head">
                <span class="people__name">{{ p.displayName }}</span>
                <span class="muted">{{ p.email }}</span>
                @if (store.suspended()) {
                  <span class="muted">{{ 'ui.people.suspendedNote' | t }}</span>
                }
              </div>
              @if (store.manages) {
                <div class="people__section">{{ 'ui.people.col.roles' | t }}</div>
                <div class="people__roles">
                  @for (r of store.roleDraft(); track r) {
                    <span class="people__role">
                      {{ store.roleLabel(r) }}
                      @if (!store.suspended()) {
                        <button type="button" [attr.aria-label]="('ui.common.remove' | t) + ' ' + store.roleLabel(r)" (click)="store.removeRoleFromDraft(r)">×</button>
                      }
                    </span>
                  }
                </div>
                @if (!store.suspended()) {
                  <app-autocomplete [source]="store.roleSource()" [placeholder]="'ui.people.addRole' | t" (chosen)="store.addRoleToDraft($event)" />
                }
              }
            }
          </div>
          <div detailFooterActions class="app-btn-group">
            @if (store.person(); as p) {
              @if (store.suspended()) {
                <button type="button" class="app-btn app-btn--primary" [disabled]="store.busy()" (click)="store.reactivate()">{{ 'ui.people.reactivate' | t }}</button>
              } @else {
                @if (store.rolesChanged()) {
                  <button type="button" class="app-btn app-btn--primary" [disabled]="store.busy()" (click)="store.saveRoles()">{{ 'ui.people.saveRoles' | t }}</button>
                }
                <button type="button" class="app-btn" [disabled]="store.busy()" (click)="store.resend()">{{ 'ui.people.resend' | t }}</button>
                <button type="button" class="app-btn danger" (click)="store.askSuspend()">{{ 'ui.people.suspend' | t }}</button>
              }
            }
          </div>
        </app-list-detail-sheet>

        <app-mobile-form-sheet
          [open]="store.confirmingSuspend() && !!store.person()"
          [title]="'ui.people.suspendTitle' | t: { name: store.person()?.displayName ?? '' }"
          [saving]="store.busy()"
          [saveLabel]="'ui.people.suspend' | t"
          [cancelLabel]="'ui.common.back' | t"
          (dismissed)="store.cancelSuspend()"
          (save)="store.confirmSuspend()">
          <p>{{ 'ui.people.suspendNote' | t: { name: store.person()?.displayName ?? '' } }}</p>
        </app-mobile-form-sheet>

        @if (store.manages) {
          <app-mobile-form-sheet
            [open]="state.add"
            [title]="'ui.crumbs.addPerson' | t"
            [saving]="store.busy()"
            [saveLabel]="(store.addInvite() ? 'ui.people.addAndInvite' : 'ui.common.add') | t"
            (dismissed)="store.close()"
            (save)="store.saveAdd()">
            <div class="field">
              <label for="add-email">{{ 'ui.people.col.email' | t }} <span class="people__required" aria-hidden="true">*</span></label>
              <input id="add-email" type="email" autocomplete="off" required aria-required="true" [attr.aria-invalid]="store.addErrors()['email'] ? 'true' : null" [attr.aria-describedby]="store.addErrors()['email'] ? 'add-email-error' : null" [value]="store.addEmail()" (input)="store.addEmail.set($any($event.target).value)" />
              @if (store.addErrors()['email']; as e) {
                <span id="add-email-error" class="error" role="alert">{{ e }}</span>
              }
            </div>
            <div class="field">
              <label for="add-name">{{ 'ui.people.col.name' | t }} <span class="people__required" aria-hidden="true">*</span></label>
              <input id="add-name" type="text" autocomplete="off" required aria-required="true" [attr.aria-invalid]="store.addErrors()['displayName'] ? 'true' : null" [attr.aria-describedby]="store.addErrors()['displayName'] ? 'add-name-error' : null" [value]="store.addName()" (input)="store.addName.set($any($event.target).value)" />
              @if (store.addErrors()['displayName']; as e) {
                <span id="add-name-error" class="error" role="alert">{{ e }}</span>
              }
            </div>
            <div class="people__section">{{ 'ui.people.col.roles' | t }} <span class="people__required" aria-hidden="true">*</span></div>
            <div class="people__roles">
              @for (r of store.addRoles(); track r) {
                <span class="people__role">
                  {{ store.roleLabel(r) }}
                  <button type="button" [attr.aria-label]="('ui.common.remove' | t) + ' ' + store.roleLabel(r)" (click)="store.removeAddRole(r)">×</button>
                </span>
              }
            </div>
            <app-autocomplete [source]="store.addSource()" [placeholder]="'ui.people.addRole' | t" (chosen)="store.addRole($event)" />
            @if (store.addErrors()['roles']; as e) {
              <span class="error" role="alert">{{ e }}</span>
            }
            <label class="people__check">
              <input type="checkbox" [checked]="store.addInvite()" (change)="store.addInvite.set($any($event.target).checked)" />
              <span>
                {{ 'ui.people.invite' | t }}
                <br /><span class="muted">{{ 'ui.people.inviteHint' | t }}</span>
              </span>
            </label>
          </app-mobile-form-sheet>

          <app-mobile-form-sheet
            [open]="!!store.bulkOp()"
            [title]="bulkTitle()"
            [saving]="store.busy()"
            [saveLabel]="'ui.bulk.apply' | t: { count: store.selectedCount() }"
            (dismissed)="store.closeBulk()"
            (save)="store.confirmBulk()">
            @if (store.bulkOp() === 'suspend') {
              <p>{{ 'ui.people.suspendNote' | t: { name: ('ui.bulk.selected' | t: { count: store.selectedCount() }) } }}</p>
            } @else {
              <div class="field">
                <label for="bulk-role">{{ 'ui.bulk.role' | t }}</label>
                <select id="bulk-role" [value]="store.bulkRole()" (change)="store.bulkRole.set($any($event.target).value)">
                  <option value=""></option>
                  @for (r of store.roleOptions(); track r.key) {
                    <option [value]="r.key">{{ r.label }}</option>
                  }
                </select>
              </div>
            }
          </app-mobile-form-sheet>
        }
      </section>
    </app-page-frame>
  `,
})
export class PeopleScreen {
  readonly store = inject(PeopleStore);

  readonly bulkShown = computed(() => this.store.bulkOperations().slice(0, this.store.narrow() ? 1 : undefined));
  readonly bulkRest = computed(() => (this.store.narrow() ? this.store.bulkOperations().slice(1) : []));
  readonly bulkTitle = computed(() => {
    const op = this.store.bulkOperations().find((o) => o.id === this.store.bulkOp());
    return op ? t('ui.bulk.title', { operation: op.label, count: this.store.selectedCount() }) : '';
  });
}
