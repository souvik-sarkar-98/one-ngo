import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { ThemePreview } from '../../builder/editors/generic/theme-preview';
import { colourPicker, type ThemeField } from '../../core/admin/theme-form';
import { TranslatePipe } from '../../services/i18n';
import { DialogFocus } from '../../ui/dialog';
import { ScreenHeading } from '../../ui/screen-heading';
import { ThemeStore } from './theme-store';

/** Organisation theme: colours, corner radius, a live preview, and a confirm step when contrast is low. */
@Component({
  selector: 'app-admin-theme',
  imports: [ScreenHeading, ThemePreview, TranslatePipe, PageFrame, DialogFocus],
  providers: [ThemeStore],
  styleUrl: '../admin.css',
  styles: `
    .theme { display: grid; gap: 16px; }
    @media (min-width: 1100px) {
      .theme { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
    }
    .theme__row { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
    .theme__row label { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
    .theme__row input[type='text'] { width: 100%; }
    .theme__row input[type='color'] { width: 42px; height: 36px; padding: 0; border: 1px solid var(--line); background: var(--card); }
    .theme__shade { position: fixed; inset: 0; background: color-mix(in srgb, var(--fg) 35%, transparent); display: grid; place-items: center; z-index: 30; }
    .theme__dialog { width: min(420px, calc(100% - 32px)); margin: 0; }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.theme' | t" />
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      <div class="theme">
        <div class="card">
          @for (field of store.fields; track field) {
            <div class="theme__row">
              <label [attr.for]="'theme-' + field">
                {{ 'ui.builder.schema.prop.' + field | t }}
                <input [id]="'theme-' + field" type="text" [value]="store.values()[field]" (input)="store.set(field, $any($event.target).value)" [attr.aria-invalid]="!!store.errors()[field]" />
              </label>
              @if (field !== 'radius') {
                <input type="color" [attr.aria-label]="'ui.builder.schema.prop.' + field | t" [value]="picker(field)" (input)="store.set(field, $any($event.target).value)" />
              }
            </div>
            @if (store.errors()[field]; as message) {
              <p class="admin__problem" role="alert">{{ message }}</p>
            }
          }
          <div class="admin__line">
            <button type="button" (click)="store.reset()">{{ 'ui.admin.theme.reset' | t }}</button>
            <button type="button" class="primary" [disabled]="!store.canPublish()" (click)="store.publish()">{{ 'ui.admin.theme.publish' | t }}</button>
          </div>
        </div>
        <app-theme-preview [body]="store.preview()" [exact]="true" />
      </div>
      @if (store.confirm()) {
        <div class="theme__shade" data-dialog-shade>
          <div class="card theme__dialog" appDialog role="dialog" aria-labelledby="theme-confirm-title" (escape)="store.confirm.set(false)">
            <h2 id="theme-confirm-title">{{ 'ui.admin.theme.confirmTitle' | t }}</h2>
            <p>{{ 'ui.admin.theme.confirmBody' | t }}</p>
            <div class="admin__line">
              <button type="button" (click)="store.confirm.set(false)">{{ 'ui.admin.theme.chooseAnother' | t }}</button>
              <button type="button" class="primary" [disabled]="!store.canPublish()" (click)="store.publish()">{{ 'ui.admin.theme.publishAnyway' | t }}</button>
            </div>
          </div>
        </div>
      }
    </app-page-frame>
  `,
})
export class ThemeScreen {
  readonly store = inject(ThemeStore);

  picker(field: ThemeField): string {
    return colourPicker(field, this.store.values()[field]);
  }
}
