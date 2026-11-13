import { Component, input, output } from '@angular/core';
import { badgeText, opensInPlace, type ClickLike } from '../logic/links.js';
import { Icon } from './icon.js';

export interface NavItem {
  key: string;
  label: string;
  icon: string;
  link: string;
  badge?: number;
  /** Opens the More menu instead of following `link`. */
  menu?: boolean;
  /** Runs a shell command instead of following `link`. */
  command?: string;
}

/** Router-neutral navigation: the owning shell supplies labels and follows links. */
@Component({
  selector: 'app-nav',
  imports: [Icon],
  styleUrl: './nav.css',
  template: `
    <nav class="nav" [class.nav--bottom]="position() === 'bottom'" [class.nav--rail]="position() === 'rail'" [attr.aria-label]="label()">
      @for (item of items(); track item.key) {
        @if (item.menu) {
          <button type="button" class="nav__item" [class.nav__item--on]="item.key === active()"
            [attr.aria-expanded]="menuOpen()" aria-haspopup="dialog" (click)="menu.emit()">
            <span class="nav__glyph">
              <app-icon [name]="item.icon" />
              @if (badge(item); as count) { <span class="nav__badge" aria-hidden="true">{{ count }}</span> }
            </span>
            <span class="nav__label">{{ item.label }}</span>
            @if (badge(item); as count) { <span class="nav__hidden">({{ count }})</span> }
          </button>
        } @else if (item.command) {
          <button type="button" class="nav__item" (click)="command.emit(item.command!)">
            <span class="nav__glyph"><app-icon [name]="item.icon" /></span>
            <span class="nav__label">{{ item.label }}</span>
          </button>
        } @else {
          <a class="nav__item" [class.nav__item--on]="item.key === active()" [attr.href]="item.link"
            [attr.aria-current]="item.key === active() ? 'page' : null" (click)="follow($event, item.link)">
            <span class="nav__glyph">
              <app-icon [name]="item.icon" />
              @if (badge(item); as count) { <span class="nav__badge" aria-hidden="true">{{ count }}</span> }
            </span>
            <span class="nav__label">{{ item.label }}</span>
            @if (badge(item); as count) { <span class="nav__hidden">({{ count }})</span> }
          </a>
        }
      }
    </nav>
  `,
})
export class Nav {
  readonly items = input.required<NavItem[]>();
  readonly active = input('');
  readonly position = input<'bottom' | 'rail'>('rail');
  readonly label = input('');
  /** Whether the More menu this bar opened is currently open. */
  readonly menuOpen = input(false);
  readonly navigate = output<string>();
  readonly menu = output<void>();
  readonly command = output<string>();

  badge(item: NavItem): string {
    return badgeText(item.badge);
  }

  follow(event: ClickLike & { preventDefault(): void }, link: string): void {
    if (!opensInPlace(event)) return;
    event.preventDefault();
    this.navigate.emit(link);
  }
}
