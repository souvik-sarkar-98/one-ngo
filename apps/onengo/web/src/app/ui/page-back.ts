import { Component, computed, inject } from '@angular/core';
import { t } from '../core/i18n/i18n';
import { I18n } from '../services/i18n';
import { ShellStore } from '../shell/shell-store';
import { Icon } from '@onengo/web-kit';

/** Back, in the page title row. Hidden on Home, Records, Inbox and More. */
@Component({
  selector: 'app-page-back',
  imports: [Icon],
  styles: `
    :host {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      width: auto;
      height: 32px;
    }
    button {
      display: inline-grid;
      place-items: center;
      width: 32px;
      height: 32px;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--fg);
      cursor: pointer;
    }
    button:hover,
    button:focus-visible {
      background: color-mix(in srgb, var(--brand) 12%, transparent);
    }
    button:focus-visible {
      outline: 2px solid var(--brand);
      outline-offset: 1px;
    }
    @media (max-width: 759.98px) {
      :host {
        height: 44px;
      }
      button {
        width: 44px;
        height: 44px;
      }
    }
  `,
  template: `
    @if (showBack()) {
      <button type="button" [attr.aria-label]="label()" (click)="back()">
        <app-icon name="back" />
      </button>
    }
  `,
})
export class PageBack {
  private readonly i18n = inject(I18n);
  private readonly shell = inject(ShellStore);
  readonly showBack = this.shell.showBack;
  readonly label = computed(() => {
    this.i18n.locale();
    return t('ui.common.back');
  });

  back(): void {
    this.shell.back();
  }
}
