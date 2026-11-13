import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { RoleScreen as BuilderRoleScreen } from '../../builder/roles/role.screen';
import { TranslatePipe } from '../../services/i18n';
import { Autocomplete } from '../../ui/autocomplete';
import { CreateButton } from '../../ui/create-button';
import { FilteredInfiniteList } from '../../ui/filtered-infinite-list';
import { MobileFormSheet } from '../../ui/form-panel';
import { FilteredListPage } from '../../ui/list-page';
import { ScreenHeading } from '../../ui/screen-heading';
import { RoleStore } from './roles-store';

/** A role (`/admin/roles/:key`): who holds it, and what it allows on the Permissions tab. */
@Component({
  selector: 'app-admin-role',
  imports: [FilteredListPage, FilteredInfiniteList, MobileFormSheet, Autocomplete, CreateButton, ScreenHeading, TranslatePipe, PageFrame, BuilderRoleScreen],
  providers: [RoleStore],
  styleUrls: ['../../ui/styles/na-list-dashboard.css', '../admin.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="store.label()" />
        @if (store.tab() === 'members' && !store.narrow()) {
          <button type="button" class="app-btn app-btn--primary admin__title-action" (click)="store.openAdd()">{{ 'ui.crumbs.addPeople' | t }}</button>
        }
      </div>
      @if (store.canPermissions()) {
        <div class="admin__tabs" role="tablist">
          <button type="button" role="tab" class="admin__tab" [class.admin__tab--on]="store.tab() === 'members'" [attr.aria-selected]="store.tab() === 'members'" (click)="store.showTab('members')">{{ 'ui.admin.roles.membersTab' | t: { count: store.state().page?.total ?? 0 } }}</button>
          <button type="button" role="tab" class="admin__tab" [class.admin__tab--on]="store.tab() === 'permissions'" [attr.aria-selected]="store.tab() === 'permissions'" (click)="store.showTab('permissions')">{{ 'ui.admin.roles.permissionsTab' | t }}</button>
        </div>
      }
      @let s = store.state();
      @if (store.tab() === 'permissions') {
        <p class="muted">{{ 'ui.admin.roles.permissionsIntro' | t }}</p>
        <app-role-screen [key]="store.key" [embedded]="true" />
      } @else {
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      <p class="muted">{{ 'ui.admin.roles.membersIntro' | t: { count: s.page?.total ?? 0 } }}</p>
      <section class="list-dashboard" [attr.aria-busy]="s.loading">
        <app-filtered-list-page>
          <app-filtered-infinite-list
            [chips]="[]"
            [items]="store.rows()"
            [loading]="s.loading"
            [error]="s.error"
            [searchText]="store.filterText()"
            [searchPlaceholder]="'ui.people.search' | t"
            [emptyMessage]="'ui.admin.empty' | t"
            [layout]="store.layout()"
            [columns]="store.columns()"
            [inlineActions]="true"
            [actionsDisabled]="s.busy"
            (searchChange)="store.filterText.set($event)"
            (retry)="store.retry()"
            (rowAction)="store.rowAction($event.row.id, $event.action)"
            (rowClick)="store.openPerson($event.id)">
          </app-filtered-infinite-list>
        </app-filtered-list-page>
        @if (store.narrow()) {
          <div class="list-dashboard__floating-actions">
            <app-create-button [label]="'ui.crumbs.addPeople' | t" (pressed)="store.openAdd()" />
          </div>
        }
      </section>

      <app-mobile-form-sheet
        [open]="store.adding()"
        [title]="'ui.admin.roles.addTitle' | t: { role: store.label() }"
        [saving]="s.busy"
        [saveLabel]="'ui.common.add' | t"
        (dismissed)="store.closeAdd()"
        (save)="store.add()">
        <app-autocomplete [source]="store.source" [label]="'ui.crumbs.admin.people' | t" (chosen)="store.pick($event)" />
        <p class="muted">{{ 'ui.admin.roles.pickHint' | t }}</p>
        <ul class="admin__list">
          @for (p of s.picked; track p.id) {
            <li class="admin__row">
              <span class="admin__label">{{ p.label }}<span class="muted">{{ p.hint }}</span></span>
              <button type="button" class="app-btn" (click)="store.unpick(p.id)">{{ 'ui.common.remove' | t }}</button>
            </li>
          }
        </ul>
        @if (store.requiresTwoStep()) {
          <p class="muted">{{ store.twoStepNote() }}</p>
        }
      </app-mobile-form-sheet>
      }
    </app-page-frame>
  `,
})
export class RoleScreen {
  readonly store = inject(RoleStore);
}
