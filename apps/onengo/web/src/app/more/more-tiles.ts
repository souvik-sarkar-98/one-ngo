import { Component, computed, input, output } from '@angular/core';
import { Icon, opensInPlace } from '@onengo/web-kit';
import type { NavEntry } from '../core/shell/shell';
import { TranslatePipe } from '../services/i18n';

/** The More menu: tiles in groups, three to a row. */
const GROUP_ORDER = ['app', 'records', 'pages', 'workspace', 'me'] as const;

function groupOf(key: string): (typeof GROUP_ORDER)[number] {
  if (key === 'admin' || key === 'builder') return 'workspace';
  if (key === 'settings') return 'me';
  if (key.startsWith('record:') || key === 'records') return 'records';
  if (key.startsWith('page:')) return 'pages';
  return 'app';
}
@Component({
  selector: 'app-more-tiles',
  imports: [Icon, TranslatePipe],
  styles: `
    .more-tiles {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .more-tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 96px;
      padding: 12px 6px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 16px;
      background: var(--card, #fff);
      color: inherit;
      font: inherit;
      font-size: 0.75rem;
      font-weight: 700;
      line-height: 1.25;
      text-align: center;
      text-decoration: none;
    }
    .more-tile:hover {
      background: color-mix(in srgb, var(--brand) 5%, #fff);
    }
    .more-group + .more-group { margin-top: 14px; }
    .more-group__title { margin: 0 2px 6px; color: var(--muted); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
    .more-tile__icon {
      --icon-size: 22px;
      width: 44px;
      height: 44px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--brand) 25%, #fff);
      color: var(--brand);
      display: grid;
      place-items: center;
    }
  `,
  template: `
    @for (group of groups(); track group.id) {
      <section class="more-group">
        @if (groups().length > 1) {
          <h2 class="more-group__title">{{ group.label | t }}</h2>
        }
        <div class="more-tiles">
          @for (tile of group.tiles; track tile.key) {
            <a class="more-tile" [attr.href]="tile.link" (click)="follow($event, tile.link)">
              <span class="more-tile__icon"><app-icon [name]="tile.icon" /></span>
              <span>{{ tile.label }}</span>
            </a>
          }
        </div>
      </section>
    }
  `,
})
export class MoreTiles {
  readonly tiles = input.required<NavEntry[]>();
  readonly open = output<string>();
  readonly groups = computed(() => {
    const tiles = this.tiles();
    return GROUP_ORDER.map((id) => ({ id, label: `ui.more.group.${id}`, tiles: tiles.filter((tile) => groupOf(tile.key) === id) })).filter((group) => group.tiles.length);
  });

  follow(event: MouseEvent, link: string): void {
    if (!opensInPlace(event)) return;
    event.preventDefault();
    this.open.emit(link);
  }
}
