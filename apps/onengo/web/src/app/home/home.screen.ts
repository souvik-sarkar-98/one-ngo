import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../services/i18n';
import { MobileFormSheet } from '../ui/form-panel';
import { ScreenHeading } from '../ui/screen-heading';
import { Widget } from '../ui/widget';
import { HomeStore } from './home-store';

/**
 * Home (`/`) and a page from More (`/pages/:key`): the page's widgets top to
 * bottom, two per row on wider screens, with the record groups across the
 * full width. Home greets the person and puts their pins first.
 */
@Component({
  selector: 'app-home',
  imports: [Widget, MobileFormSheet, ScreenHeading, TranslatePipe, PageFrame],
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
        <div class="home__grid" [class.home__grid--two]="!store.narrow()">
          @for (w of store.widgets(); track w.id) {
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
          }
        </div>
      }
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
}
