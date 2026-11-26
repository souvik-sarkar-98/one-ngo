import { Component, inject, signal } from '@angular/core';
import { Btn, Icon, opensInPlace, PageFrame } from '@onengo/web-kit';
import type { ProfileStatus } from '../../core/admin/migration';
import { TranslatePipe } from '../../services/i18n';
import { MobileFormSheet } from '../../ui/form-panel';
import { ScreenHeading } from '../../ui/screen-heading';
import { MigrationStore } from './migration-store';

/** Data migrations of the organisation, newest first, and a new one by name. */
@Component({
  selector: 'app-admin-migrations',
  imports: [Btn, Icon, ScreenHeading, TranslatePipe, PageFrame, MobileFormSheet],
  providers: [MigrationStore],
  styleUrls: ['../admin.css', './migration.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="'ui.crumbs.admin.migration' | t" />
        @if (store.allowed()) {
          <button appBtn="primary" type="button" class="admin__title-action" [disabled]="store.snap().busy" (click)="openNew()">{{ 'ui.admin.migration.new' | t }}</button>
        }
      </div>
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
        <p class="muted">{{ 'ui.admin.migration.intro' | t }}</p>
        <app-mobile-form-sheet
          [open]="creating()"
          [title]="'ui.admin.migration.new' | t"
          [error]="s.error"
          [saving]="s.busy"
          [saveLabel]="'ui.common.create' | t"
          (dismissed)="closeNew()"
          (save)="store.create()">
          <form (submit)="$event.preventDefault(); store.create()">
            <label class="migration__field">
              <span>{{ 'ui.admin.migration.name' | t }}</span>
              <input type="text" maxlength="120" autofocus [value]="store.name()" (input)="store.name.set($any($event.target).value)" />
            </label>
          </form>
        </app-mobile-form-sheet>
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
  /** Whether the dialog asking for the name of a new migration is open. */
  readonly creating = signal(false);

  openNew(): void {
    this.store.name.set('');
    this.creating.set(true);
  }

  closeNew(): void {
    this.creating.set(false);
    this.store.name.set('');
  }

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
