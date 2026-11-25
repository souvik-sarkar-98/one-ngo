import { Component, inject } from '@angular/core';
import { Btn, Icon, opensInPlace, PageFrame } from '@onengo/web-kit';
import type { ProfileStatus } from '../../core/admin/migration';
import { TranslatePipe } from '../../services/i18n';
import { ScreenHeading } from '../../ui/screen-heading';
import { MigrationStore } from './migration-store';

/** Data migrations of the organisation, newest first, and a new one by name. */
@Component({
  selector: 'app-admin-migrations',
  imports: [Btn, Icon, ScreenHeading, TranslatePipe, PageFrame],
  providers: [MigrationStore],
  styleUrls: ['../admin.css', './migration.css'],
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.migration' | t" />
      @if (!store.allowed()) {
        <div class="notice error" role="alert">{{ 'ui.admin.migration.denied' | t }}</div>
      } @else {
        @let s = store.snap();
        @if (store.notice(); as n) {
          <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
        }
        @if (s.error) {
          <div class="notice error" role="alert">{{ s.error }}</div>
        }
        <form class="migration__card" (submit)="$event.preventDefault(); store.create()">
          <div class="migration__head">
            <p>{{ 'ui.admin.migration.intro' | t }}</p>
          </div>
          <div class="migration__new">
            <label class="migration__field">
              <span>{{ 'ui.admin.migration.name' | t }}</span>
              <input type="text" maxlength="120" [value]="store.name()" (input)="store.name.set($any($event.target).value)" />
            </label>
            <button appBtn="primary" type="submit" class="migration__btn-icon" [disabled]="s.busy"><app-icon name="add" />{{ 'ui.admin.migration.new' | t }}</button>
          </div>
        </form>
        @if (s.loading) {
          <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
        } @else if (!s.list.length) {
          <div class="migration__empty">
            <span class="migration__icon"><app-icon name="upload" /></span>
            <span>{{ 'ui.admin.migration.empty' | t }}</span>
          </div>
        } @else {
          <ul class="admin__list migration__list">
            @for (p of s.list; track p.id) {
              <li>
                <a class="admin__row" [attr.href]="'/admin/migration/' + p.id + '/files'" (click)="follow($event, p.id)">
                  <span class="migration__icon" [attr.data-status]="p.status"><app-icon name="file" /></span>
                  <span class="admin__label">
                    <strong>{{ p.name }}</strong>
                    <span class="muted">{{ 'ui.admin.migration.fileCount' | t: { count: p.files } }} · {{ 'ui.admin.migration.updatedOn' | t: { date: p.updatedAt.slice(0, 10) } }}</span>
                  </span>
                  <span [class]="'badge ' + tone(p.status)">{{ 'ui.admin.migration.status.' + p.status | t }}</span>
                  <app-icon class="migration__chevron" name="next" />
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

  /** The badge colour of a status. */
  tone(status: ProfileStatus): string {
    return status === 'done' ? 'ok' : status === 'failed' ? 'bad' : status === 'checked' ? 'warn' : '';
  }

  follow(e: MouseEvent, id: string): void {
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.store.open(id);
  }
}
