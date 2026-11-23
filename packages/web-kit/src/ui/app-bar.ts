import { Component, computed, input, output } from '@angular/core';
import { badgeText, opensInPlace } from '../logic/links.js';
import { Icon } from './icon.js';

/**
 * The bar at the top of every screen: the product name, the organisation's logo when it has one, and a
 * context line (the organisation, or the console's name). An inbox bell with its badge shows when it
 * has a link, and the person's initials stay visible. Links are followed by whoever owns the router.
 */
@Component({
  selector: 'app-bar',
  imports: [Icon],
  styleUrl: './app-bar.css',
  template: `
    <header class="app-bar">
      <div class="app-bar__brand">
        <span class="app-bar__product">{{ product() }}</span>
        @if (logo()) {
          <img class="app-bar__logo" [src]="logo()" alt="" />
        }
        @if (context()) {
          <span class="app-bar__org">{{ context() }}</span>
        }
      </div>
      <ng-content />
      @if (inboxLink(); as link) {
        <a class="app-bar__icon" [attr.href]="link" [attr.aria-label]="inboxText()" (click)="follow($event, link)">
          <app-icon name="bell" />
          @if (badge()) {
            <span class="app-bar__badge" aria-hidden="true">{{ badge() }}</span>
          }
        </a>
      }
      @if (initials()) {
        <span class="app-bar__avatar" role="img" [attr.aria-label]="accountLabel()" [attr.title]="accountLabel() || null">{{ initials() }}</span>
      }
    </header>
  `,
})
export class AppBar {
  readonly product = input.required<string>();
  /** The signed-in organisation, or the console's name. The bar keeps this on every screen. */
  readonly context = input('');
  /** A same-origin mark. Omitted when the organisation has none. */
  readonly logo = input<string | null>(null);
  /** Where the inbox bell goes; the bell is left out without it. */
  readonly inboxLink = input<string | null>(null);
  /** Approvals waiting for the person. */
  readonly inboxCount = input(0);
  readonly inboxLabel = input('Inbox');
  readonly initials = input('');
  readonly accountLabel = input('Account');
  readonly navigate = output<string>();

  readonly badge = computed(() => badgeText(this.inboxCount()));
  readonly inboxText = computed(() => (this.badge() ? `${this.inboxLabel()} (${this.badge()})` : this.inboxLabel()));

  follow(e: MouseEvent, link: string): void {
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.navigate.emit(link);
  }
}
