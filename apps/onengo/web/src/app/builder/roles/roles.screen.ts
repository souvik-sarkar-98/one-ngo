import { Component, computed, inject, signal } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { roleKey } from '../../core/builder/permission-grid';
import { t } from '../../core/i18n/i18n';
import type { RowView } from '../../core/rows';
import { TranslatePipe } from '../../services/i18n';
import { InfiniteListRow } from '../../ui/card-rows';
import { MobileFormSheet } from '../../ui/form-panel';
import { opensRow } from '../../ui/row-keys';
import { PageBack } from '../../ui/page-back';
import { TableRows, type TableColumn } from '../../ui/table-rows';
import { RolesStore } from './roles-store';

/** Builder › Roles: every role with its member count; who has a role is managed in Administration. */
@Component({
  selector: 'app-roles-screen',
  imports: [TranslatePipe, TableRows, InfiniteListRow, MobileFormSheet, PageBack, PageFrame],
  providers: [RolesStore],
  styleUrl: '../builder.css',
  template: `
    <app-page-frame>
      <header class="builder-head">
        <app-page-back />
        <h1>{{ 'ui.crumbs.builder.roles' | t }}</h1>
        <span class="builder-spacer"></span>
        @if (store.canEdit()) {
          <button type="button" class="primary" (click)="startNew()">{{ 'ui.builder.roles.new' | t }}</button>
        }
      </header>
      <p class="muted">{{ 'ui.builder.roles.intro' | t }}</p>
      @if (!store.canManage()) { <div class="notice info">{{ 'ui.builder.roles.needsPermission' | t }}</div> }
      @if (store.error()) { <div class="notice error" role="alert">{{ store.error() }}</div> }
      @if (store.message()) { <div class="notice ok" role="status">{{ store.message() }}</div> }

      @if (store.loading()) {
        <p class="muted">{{ 'ui.common.loading' | t }}</p>
      } @else if (store.narrow()) {
        <div class="builder-cards">
          @for (r of store.rows(); track r.id) {
            <div class="builder-card" role="button" tabindex="0" (click)="store.openRole(r.id)" (keydown)="key($event, r)">
              <app-infinite-list-row [item]="r" />
            </div>
          }
        </div>
      } @else if (store.rows().length) {
        <div class="builder-panel">
          <app-table-rows [rows]="store.rows()" [columns]="columns()" (rowClick)="store.openRole($event.id)" (rowAction)="rowAction($event.row, $event.action)" />
        </div>
      }

      <app-mobile-form-sheet
        [open]="store.creating()"
        [title]="'ui.builder.roles.new' | t"
        [saving]="store.busy()"
        [saveLabel]="'ui.common.create' | t"
        (dismissed)="store.creating.set(false)"
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
  readonly columns = computed<TableColumn[]>(() => [
    { key: 'label', label: t('ui.builder.name') },
    { key: 'key', label: t('ui.builder.key') },
    { key: 'members', label: t('ui.builder.roles.membersColumn') },
    { key: 'twoStep', label: t('ui.builder.roles.twoStep') },
    { key: 'from', label: t('ui.builder.catalogue.from') },
  ]);

  constructor() {
    void this.store.loadList();
  }

  startNew(): void {
    this.name.set('');
    this.store.startNew();
  }

  rowAction(row: RowView, action: string): void {
    if (action === 'delete' && !confirm(t('ui.builder.roles.confirmDelete', { role: row.title }))) return;
    void this.store.runRowAction(row.id, action);
  }

  key(e: KeyboardEvent, r: RowView): void {
    if (!opensRow(e)) return;
    e.preventDefault();
    this.store.openRole(r.id);
  }
}
