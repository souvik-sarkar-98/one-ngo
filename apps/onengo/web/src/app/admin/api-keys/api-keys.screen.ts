import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { CfForm } from '../../ui/cf-form';
import { CreateButton } from '../../ui/create-button';
import { FilteredInfiniteList } from '../../ui/filtered-infinite-list';
import { MobileFormSheet } from '../../ui/form-panel';
import { FilteredListPage } from '../../ui/list-page';
import { RowMenu } from '../../ui/row-menu';
import { ScreenHeading } from '../../ui/screen-heading';
import { ApiKeysStore } from './api-keys-store';

/** API keys: list with role and last use, create with the secret shown once, revoke confirmed in the panel, and the API documentation. */
@Component({
  selector: 'app-admin-api-keys',
  imports: [FilteredListPage, FilteredInfiniteList, MobileFormSheet, CfForm, CreateButton, RowMenu, ScreenHeading, TranslatePipe, PageFrame],
  providers: [ApiKeysStore],
  styleUrls: ['../../ui/styles/na-list-dashboard.css', '../admin.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="'ui.crumbs.admin.apiKeys' | t" />
        @if (!store.narrow()) {
          <button type="button" class="app-btn app-btn--primary admin__title-action" (click)="store.keys.openCreate()">{{ 'ui.crumbs.newApiKey' | t }}</button>
        }
      </div>
      @let s = store.state();
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      <div class="admin__line admin__card">
        <span class="admin__grow"></span>
        <a [attr.href]="store.documentation" target="_blank" rel="noopener">{{ 'ui.admin.keys.docs' | t }} ↗</a>
      </div>
      <section class="list-dashboard" [attr.aria-busy]="s.loading">
        <app-filtered-list-page>
          <app-filtered-infinite-list
            [chips]="[]"
            [toolbar]="false"
            [items]="store.rows()"
            [loading]="s.loading"
            [error]="s.error"
            [emptyMessage]="'ui.admin.empty' | t"
            [layout]="store.layout()"
            [columns]="store.columns()"
            [rowTrailing]="rowTrailing"
            badgeKey="state"
            (retry)="store.keys.load()"
            (rowAction)="store.rowAction($event.row.id, $event.action)">
          </app-filtered-infinite-list>
        </app-filtered-list-page>
        <ng-template #rowTrailing let-row>
          @if (row.actions.length) {
            <app-row-menu [actions]="row.actions" (choose)="store.rowAction(row.id, $event)" />
          }
        </ng-template>
        @if (store.narrow()) {
          <div class="list-dashboard__floating-actions">
            <app-create-button [label]="'ui.crumbs.newApiKey' | t" (pressed)="store.keys.openCreate()" />
          </div>
        }
      </section>

      <app-mobile-form-sheet
        [open]="store.creating()"
        [title]="'ui.crumbs.newApiKey' | t"
        [saving]="s.busy"
        [saveLabel]="'ui.admin.keys.create' | t"
        (dismissed)="store.keys.closeCreate()"
        (save)="store.create()">
        <cf-form [fields]="store.fields()" [values]="store.values()" [errors]="store.errors()" idPrefix="api-key" (valuesChange)="store.values.set($event)" />
      </app-mobile-form-sheet>

      <app-mobile-form-sheet [open]="!!s.created" [title]="'ui.admin.keys.created' | t" [showDefaultFooter]="false" (dismissed)="store.keys.dismissSecret()">
        @if (s.created; as c) {
          <div class="notice error">{{ 'ui.admin.keys.copyNow' | t }}</div>
          <span class="muted">
            {{ c.name }} ·
            @if (c.feed) {
              {{ 'ui.admin.keys.readsFeed' | t: { feed: store.keys.feedLabel(c.feed) } }}
            } @else {
              {{ 'ui.admin.keys.actsAs' | t: { role: store.keys.roleLabel(c.role ?? '') } }}
            }
          </span>
          <div class="admin__secret">{{ c.token }}</div>
          <button type="button" class="app-btn" (click)="store.copy()">{{ (store.copied() ? 'ui.admin.keys.copied' : 'ui.admin.keys.copy') | t }}</button>
          @if (c.feed) {
            <p class="muted">{{ 'ui.admin.keys.call' | t }} <code>GET /api/data/{{ store.organisationCode() }}/{{ c.feed }}</code></p>
          }
          <p class="muted">{{ 'ui.admin.keys.header' | t }} <code>Authorization: ApiKey &lt;id&gt;.&lt;secret&gt;</code></p>
        }
        <button sheetFooterActions type="button" class="app-btn app-btn--primary" (click)="store.keys.dismissSecret()">{{ 'ui.admin.keys.done' | t }}</button>
      </app-mobile-form-sheet>

      <app-mobile-form-sheet
        [open]="!!s.revoking"
        [title]="'ui.admin.keys.revokeTitle' | t: { name: s.revoking?.name ?? '' }"
        [saving]="s.busy"
        [saveLabel]="'ui.admin.keys.revoke' | t"
        (dismissed)="store.keys.cancelRevoke()"
        (save)="store.confirmRevoke()">
        <p>{{ 'ui.admin.keys.revokeNote' | t }}</p>
      </app-mobile-form-sheet>
    </app-page-frame>
  `,
})
export class ApiKeysScreen {
  readonly store = inject(ApiKeysStore);
}
