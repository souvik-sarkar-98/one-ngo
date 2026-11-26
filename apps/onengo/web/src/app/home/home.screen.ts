import { NgTemplateOutlet } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Icon, PageFrame, opensInPlace } from '@onengo/web-kit';
import { TranslatePipe } from '../services/i18n';
import { ChipFilterBar } from '../ui/chip-bar';
import { MobileFormSheet } from '../ui/form-panel';
import { ScreenHeading } from '../ui/screen-heading';
import { Widget } from '../ui/widget';
import { HomeStore } from './home-store';

/**
 * Home (`/`) and a page from More (`/pages/:key`), drawn the same way: the
 * person's pinned lists (Home only); the task cards (the links of the page's
 * task-card widgets, one filter pill per widget, each link a card that opens a
 * form or screen); then the other widgets, two per row on wider screens.
 *
 * Home also greets the person and ends with the record groups, folded away once
 * there is something above them. Its search box narrows the task cards and the
 * record groups together; a page from More has one only when it has task cards.
 */
@Component({
  selector: 'app-home',
  imports: [Widget, MobileFormSheet, ScreenHeading, TranslatePipe, PageFrame, ChipFilterBar, NgTemplateOutlet, Icon],
  providers: [HomeStore],
  styles: `
    :host {
      display: block;
    }
    .home__welcome {
      margin: 0 0 12px;
      font-weight: 600;
    }
    .home__updated {
      margin: 0 0 10px;
      font-size: 0.78rem;
    }
    .home__grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      column-gap: 12px;
      align-items: start;
    }
    .home__grid--two {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .home__full {
      grid-column: 1 / -1;
    }
    .home__field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .home__h {
      margin: 6px 0 8px;
      font-size: 0.95rem;
      font-weight: 700;
    }
    .home__tasks {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
      gap: 10px;
      margin: 0 0 16px;
      padding: 0;
      list-style: none;
    }
    .home__task {
      display: flex;
      flex-direction: column;
      gap: 4px;
      height: 100%;
      padding: 12px 14px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 14px;
      background: var(--card);
      color: var(--fg);
      text-decoration: none;
      box-sizing: border-box;
      --icon-size: 18px;
    }
    .home__task:hover,
    .home__task:focus-visible {
      border-color: var(--brand);
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.08);
    }
    .home__task-area {
      color: var(--help-color, #5b6878);
      font-size: 0.66rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .home__task-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 0.9rem;
      font-weight: 700;
    }
    .home__task-label app-icon {
      color: var(--brand);
    }
    .home__browse {
      margin: 6px 0 12px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 14px;
      background: var(--card);
    }
    .home__browse > summary {
      padding: 12px 14px;
      font-weight: 700;
      font-size: 0.9rem;
      cursor: pointer;
    }
    .home__browse[open] > summary {
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
    }
    .home__browse-body {
      padding: 12px;
    }
  `,
  template: `
    <app-page-frame>
      @let plan = store.plan();
      @if (store.heading()) {
        <app-screen-heading [text]="store.heading()" />
      }
      @if (store.notice()) {
        <div class="notice error" role="alert">{{ store.notice() }}</div>
      }
      @if (store.denied()) {
        <div class="notice error" role="alert">{{ 'ui.pages.noAccess' | t }}</div>
      }
      @if (!plan) {
        <div class="notice info">{{ 'ui.pages.noAccess' | t }}</div>
      } @else {
        @if (store.isHome()) {
          <p class="home__welcome">{{ store.welcome() }}</p>
          @if (store.noRecords()) {
            <div class="notice info">{{ 'ui.home.noAccess' | t }}</div>
          }
        } @else if (store.updated()) {
          <p class="muted home__updated">{{ store.updated() }}</p>
        }
        @if (!store.isHome() && store.areas().length) {
          <input
            type="search"
            class="search-input"
            [attr.aria-label]="'ui.home.search' | t"
            [placeholder]="'ui.home.search' | t"
            [value]="store.query()"
            (input)="search($event)" />
        }

        @if (store.pinned().length) {
          <h2 class="home__h">{{ 'ui.home.pinned' | t }}</h2>
          <div class="home__grid" [class.home__grid--two]="!store.narrow()">
            @for (w of store.pinned(); track w.id) {
              <ng-container [ngTemplateOutlet]="widgetTpl" [ngTemplateOutletContext]="{ $implicit: w }" />
            }
          </div>
        }

        @if (store.areas().length) {
          <h2 class="home__h">{{ 'ui.home.start' | t }}</h2>
          @if (store.areas().length > 1) {
            <app-chip-filter-bar [chips]="store.areaChips()" [activeId]="store.area() ?? ''" (chipSelect)="store.area.set($event || null)" />
          }
          @if (store.tasks().length) {
            <ul class="home__tasks">
              @for (c of store.tasks(); track c.area + c.to + c.label) {
                <li>
                  <a class="home__task" [attr.href]="c.to" (click)="follow($event, c.to)">
                    <span class="home__task-area">{{ c.area }}</span>
                    <span class="home__task-label">
                      <span>{{ c.label }}</span>
                      <app-icon name="next" />
                    </span>
                  </a>
                </li>
              }
            </ul>
          } @else {
            <p class="muted" role="status">{{ 'ui.home.searchEmpty' | t }}</p>
          }
        }

        @if (store.others().length) {
          <div class="home__grid" [class.home__grid--two]="!store.narrow()">
            @for (w of store.others(); track w.id) {
              <ng-container [ngTemplateOutlet]="widgetTpl" [ngTemplateOutletContext]="{ $implicit: w }" />
            }
          </div>
        }

        @if (store.groups().length) {
          <details class="home__browse" [open]="store.browseOpen()">
            <summary>{{ 'ui.home.browse' | t }}</summary>
            <div class="home__browse-body">
              @for (w of store.groups(); track w.id) {
                <ng-container [ngTemplateOutlet]="widgetTpl" [ngTemplateOutletContext]="{ $implicit: w }" />
              }
            </div>
          </details>
        } @else if (store.isHome() && store.searching() && !store.areas().length) {
          <p class="muted" role="status">{{ 'ui.home.searchEmpty' | t }}</p>
        }
      }
      <ng-template #widgetTpl let-w>
        <app-widget
          [class.home__full]="w.full"
          [widget]="w.model"
          [loading]="w.loading"
          [error]="w.error"
          [format]="store.format"
          [tag]="w.tag"
          [menu]="w.menu"
          (navigate)="store.open($event)"
          (rowClick)="store.openRow(w.id, $event)"
          (retry)="store.retry(w.id)"
          (menuChoose)="store.choosePinAction(w.id, $event)" />
      </ng-template>
      @defer (when store.renaming()) {
        @if (store.renaming(); as r) {
          <app-mobile-form-sheet [open]="true" [title]="'ui.pins.renameTitle' | t" [saving]="store.saving()" (dismissed)="store.renaming.set(null)" (save)="store.saveRename()">
            <label class="home__field">
              <span>{{ 'ui.pins.name' | t }}</span>
              <input type="text" maxlength="80" [value]="r.label" (input)="rename(r.id, $event)" (keydown.enter)="store.saveRename()" />
            </label>
          </app-mobile-form-sheet>
        }
      }
    </app-page-frame>
  `,
})
export class HomeScreen {
  readonly store = inject(HomeStore);

  rename(id: string, e: Event): void {
    this.store.renaming.set({ id, label: (e.target as HTMLInputElement).value });
  }

  search(e: Event): void {
    this.store.query.set((e.target as HTMLInputElement).value);
  }

  /** Follows an in-app link without reloading, unless the person meant a new tab or window. */
  follow(e: MouseEvent, link: string): void {
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.store.open(link);
  }
}
