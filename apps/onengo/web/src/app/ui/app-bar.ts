import { Component, computed, input, output } from '@angular/core';
import { t } from '../core/i18n/i18n';
import { PRODUCT } from '../core/organisation/organisation';
import { badgeText, Icon, opensInPlace } from '@onengo/web-kit';
import { withDefaults } from './labels';

const LABELS = () => ({ inbox: t('ui.nav.inbox'), account: t('ui.nav.account') });

/** The product name in the app bar. It does not change from screen to screen. */
export const PRODUCT_NAME = PRODUCT;

/**
 * The bar at the top of every screen: the product name, the organisation's
 * logo when it has one, and the organisation's name. The inbox bell carries
 * its badge. The account initials stay visible; Sign out is a sidebar icon.
 * Links are followed by whoever owns the router.
 */
@Component({
  selector: 'app-bar',
  imports: [Icon],
  styleUrl: './styles/app-bar.css',
  template: `
    <header class="app-bar">
      <div class="app-bar__brand">
        <span class="app-bar__product">{{ productName }}</span>
        @if (logo()) {
          <img class="app-bar__logo" [src]="logo()" alt="" />
        }
        @if (organisation()) {
          <span class="app-bar__org">{{ organisation() }}</span>
        }
      </div>
      <ng-content></ng-content>
      <a class="app-bar__icon" [attr.href]="inboxLink()" [attr.aria-label]="inboxLabel()" (click)="follow($event, inboxLink())">
        <app-icon name="bell" />
        @if (badge()) {
          <span class="app-bar__badge" aria-hidden="true">{{ badge() }}</span>
        }
      </a>
      @if (initials()) {
        <span class="app-bar__avatar" role="img" [attr.aria-label]="labels().account">{{ initials() }}</span>
      }
    </header>
  `,
})
export class AppBar {
  readonly productName = PRODUCT_NAME;
  /** The signed-in organisation. The bar keeps this on every screen. */
  readonly organisation = input('');
  /** A same-origin mark. Omitted when the organisation has none. */
  readonly logo = input<string | null>(null);
  /** Approvals waiting for the person; unread notifications are not counted here. */
  readonly inboxCount = input(0);
  readonly initials = input('');
  readonly inboxLink = input('/inbox');
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  readonly navigate = output<string>();

  readonly badge = computed(() => badgeText(this.inboxCount()));
  readonly inboxLabel = computed(() => (this.badge() ? `${this.labels().inbox} (${this.badge()})` : this.labels().inbox));

  follow(e: MouseEvent, link: string): void {
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.navigate.emit(link);
  }
}
