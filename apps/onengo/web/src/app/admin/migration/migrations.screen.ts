import { Component, inject } from '@angular/core';
import { opensInPlace, PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../../services/i18n';
import { ScreenHeading } from '../../ui/screen-heading';
import { MigrationStore } from './migration-store';

/** Data migrations of the organisation, newest first, and a new one by name. */
@Component({
  selector: 'app-admin-migrations',
  imports: [ScreenHeading, TranslatePipe, PageFrame],
  providers: [MigrationStore],
  styleUrls: ['../admin.css', './migration.css'],
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.migration' | t" />
      @if (!store.allowed()) {
        <div class="notice error" role="alert">{{ 'ui.admin.migration.denied' | t }}</div>
      } @else {
        @let s = store.snap();
        <p class="muted">{{ 'ui.admin.migration.intro' | t }}</p>
        @if (store.notice(); as n) {
          <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
        }
        @if (s.error) {
          <div class="notice error" role="alert">{{ s.error }}</div>
        }
        <form class="migration__new admin__card" (submit)="$event.preventDefault(); store.create()">
          <label class="migration__field">
            <span>{{ 'ui.admin.migration.name' | t }}</span>
            <input type="text" maxlength="120" [value]="store.name()" (input)="store.name.set($any($event.target).value)" />
          </label>
          <button type="submit" class="app-btn app-btn--primary" [disabled]="s.busy">{{ 'ui.admin.migration.new' | t }}</button>
        </form>
        @if (s.loading) {
          <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
        } @else if (!s.list.length) {
          <p class="muted">{{ 'ui.admin.migration.empty' | t }}</p>
        } @else {
          <ul class="admin__list">
            @for (p of s.list; track p.id) {
              <li>
                <a class="admin__row" [attr.href]="'/admin/migration/' + p.id + '/files'" (click)="follow($event, p.id)">
                  <span class="admin__label">
                    <strong>{{ p.name }}</strong>
                    <span class="muted">{{ 'ui.admin.migration.fileCount' | t: { count: p.files } }}</span>
                  </span>
                  <span class="migration__badge" [attr.data-status]="p.status">{{ 'ui.admin.migration.status.' + p.status | t }}</span>
                  ›
                </a>
              </li>
            }
          </ul>
        }
      }
    </app-page-frame>
  `,
})
export class MigrationsScreen {
  readonly store = inject(MigrationStore);

  follow(e: MouseEvent, id: string): void {
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.store.open(id);
  }
}
