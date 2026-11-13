import { Component, input, output } from '@angular/core';
import { Icon, opensInPlace, type ClickLike } from '@onengo/web-kit';
import type { NavEntry } from '../core/shell/shell';

/** The links that do not fit on the bar, as icon tiles. Settings stays on its own screen. */
@Component({
  selector: 'app-more-tray',
  imports: [Icon],
  styles: `
    .more-tray {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin: 0;
      padding: 0 0 8px;
      list-style: none;
    }
    .more-tray > li {
      display: flex;
      min-width: 0;
    }
    .more-tray__tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      width: 100%;
      height: 104px;
      min-width: 0;
      margin: 0;
      padding: 16px 8px 12px;
      box-sizing: border-box;
      overflow: hidden;
      border: 1px solid var(--line, #e6ebf1);
      border-radius: 16px;
      background: var(--card, #fff);
      color: var(--fg, #1d2733);
      font: inherit;
      text-align: center;
      text-decoration: none;
      cursor: pointer;
    }
    .more-tray__tile:hover {
      border-color: color-mix(in srgb, var(--brand, #1f5f8b) 35%, var(--line, #e6ebf1));
    }
    .more-tray__icon {
      display: grid;
      flex: 0 0 42px;
      place-items: center;
      width: 42px;
      height: 42px;
      overflow: hidden;
      border-radius: 12px;
      background: color-mix(in srgb, var(--brand, #1f5f8b) 10%, var(--card, #fff));
      color: var(--brand, #1f5f8b);
      --icon-size: 22px;
    }
    .more-tray__label {
      display: block;
      width: 100%;
      min-width: 0;
      overflow: hidden;
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  template: `
    <ul class="more-tray">
      @for (item of items(); track item.key) {
        <li>
          @if (item.command) {
            <button type="button" class="more-tray__tile" [attr.title]="item.label" (click)="command.emit(item.command!)">
              <span class="more-tray__icon"><app-icon [name]="item.icon" /></span>
              <span class="more-tray__label">{{ item.label }}</span>
            </button>
          } @else {
            <a class="more-tray__tile" [href]="item.link" [attr.title]="item.label" (click)="follow($event, item.link)">
              <span class="more-tray__icon"><app-icon [name]="item.icon" /></span>
              <span class="more-tray__label">{{ item.label }}</span>
            </a>
          }
        </li>
      }
    </ul>
  `,
})
export class MoreTray {
  readonly items = input.required<NavEntry[]>();
  readonly open = output<string>();
  readonly command = output<string>();

  follow(event: ClickLike & { preventDefault(): void }, link: string): void {
    if (!opensInPlace(event)) return;
    event.preventDefault();
    this.open.emit(link);
  }
}
