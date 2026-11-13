import { Component, computed, inject, signal } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { roleKey } from '../../core/builder/permission-grid';
import { TranslatePipe } from '../../services/i18n';
import { CreateButton } from '../../ui/create-button';
import { FilteredInfiniteList } from '../../ui/filtered-infinite-list';
import { MobileFormSheet } from '../../ui/form-panel';
import { FilteredListPage } from '../../ui/list-page';
import { ScreenHeading } from '../../ui/screen-heading';
import { RolesStore } from './roles-store';

/** Administration › Roles: one list. A role's page has its members and, for people who can, its permissions. */
@Component({
  selector: 'app-admin-roles',
  imports: [FilteredListPage, FilteredInfiniteList, ScreenHeading, TranslatePipe, PageFrame, MobileFormSheet, CreateButton],
  providers: [RolesStore],
  styleUrls: ['../../ui/styles/na-list-dashboard.css', '../admin.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="'ui.crumbs.admin.roles' | t" />
        @if (store.canCreate() && !store.narrow()) {
          <button type="button" class="app-btn app-btn--primary admin__title-action" (click)="store.startNew()">{{ 'ui.builder.roles.new' | t }}</button>
        }
      </div>
      <p class="muted">{{ 'ui.admin.roles.intro' | t }}</p>
      @let s = store.state();
      <section class="list-dashboard" [attr.aria-busy]="s.loading">
        <app-filtered-list-page>
          <app-filtered-infinite-list
            [chips]="[]"
            [items]="store.rows()"
            [loading]="s.loading"
            [error]="s.error"
            [searchText]="store.filterText()"
            [searchPlaceholder]="'ui.admin.roles.search' | t"
            [emptyMessage]="'ui.admin.empty' | t"
            [layout]="store.layout()"
            [columns]="store.columns()"
            badgeKey="twoStep"
            (searchChange)="store.filterText.set($event)"
            (retry)="store.retry()"
            (rowClick)="store.open($event.id)">
          </app-filtered-infinite-list>
        </app-filtered-list-page>
        @if (store.canCreate() && store.narrow()) {
          <div class="list-dashboard__floating-actions">
            <app-create-button [label]="'ui.builder.roles.new' | t" (pressed)="store.startNew()" />
          </div>
        }
      </section>
      <app-mobile-form-sheet
        [open]="store.creating()"
        [title]="'ui.builder.roles.new' | t"
        [saving]="store.busy()"
        [saveLabel]="'ui.common.create' | t"
        (dismissed)="store.cancelNew()"
        (save)="store.create(name())">
        <div class="field">
          <label for="new-role">{{ 'ui.builder.roles.name' | t }}</label>
          <input id="new-role" [value]="name()" (input)="name.set($any($event.target).value)" />
          @if (newKey()) { <div class="help">{{ 'ui.builder.keyHint' | t: { key: newKey() } }}</div> }
        </div>
        @if (store.createError()) { <div class="error" role="alert">{{ store.createError() }}</div> }
      </app-mobile-form-sheet>
    </app-page-frame>
  `,
})
export class RolesScreen {
  readonly store = inject(RolesStore);
  readonly name = signal('');
  readonly newKey = computed(() => roleKey(this.name()));
}
