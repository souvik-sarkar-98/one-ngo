import { Component, inject } from '@angular/core';
import { Icon, opensInPlace, PageFrame } from '@onengo/web-kit';
import { TranslatePipe } from '../services/i18n';
import { ScreenHeading } from '../ui/screen-heading';
import { GroupsStore } from './groups-store';

/**
 * Records: every record type the person can read, by record group, in one
 * column on every size. Groups collapse and stay so; a search box appears
 * when there are more than eight record types. No counts.
 *
 * Looks come from the global classes (`sec-head`, `panel`, `list-rows`,
 * `list-row`, `search-input`) and their tokens in styles.css.
 */
@Component({
  selector: 'app-records-screen',
  imports: [Icon, ScreenHeading, TranslatePipe, PageFrame],
  providers: [GroupsStore],
  styles: `
    :host {
      display: block;
    }
    .groups__heading {
      margin: 0;
      font-size: inherit;
    }
    .sec-head,
    .list-row {
      --icon-size: 18px;
    }
    .sec-head {
      --icon-size: 20px;
    }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.nav.records' | t" />
      @let m = store.model();
      @if (m.search) {
        <input
          type="search"
          class="search-input"
          [attr.aria-label]="'ui.records.searchTypes' | t"
          [placeholder]="'ui.records.searchTypes' | t"
          [value]="store.query()"
          (input)="search($event)" />
      }
      @if (m.empty) {
        <p class="muted" role="status">{{ 'ui.records.noTypeMatch' | t }}</p>
      } @else if (!m.sections.length) {
        <div class="notice info">{{ 'ui.home.noAccess' | t }}</div>
      }
      @for (s of m.sections; track s.key) {
        <section>
          <h2 class="groups__heading">
            <button type="button" class="sec-head" [attr.aria-expanded]="!s.collapsed" [attr.aria-controls]="'group-' + s.key" (click)="store.toggle(s.key)">
              <span>{{ s.label }}</span>
              <app-icon [name]="s.collapsed ? 'down' : 'up'" />
            </button>
          </h2>
          @if (!s.collapsed) {
            <ul class="panel list-rows" [id]="'group-' + s.key">
              @for (x of s.types; track x.key) {
                <li>
                  <a class="list-row" [attr.href]="x.link" (click)="follow($event, x.link)">
                    <span class="list-row__text">
                      <strong>{{ x.label }}</strong>
                      @if (x.hint) {
                        <span class="list-row__sub">{{ x.hint }}</span>
                      }
                    </span>
                    <app-icon name="next" />
                  </a>
                </li>
              }
            </ul>
          }
        </section>
      }
    </app-page-frame>
  `,
})
export class RecordsScreen {
  readonly store = inject(GroupsStore);

  search(e: Event): void {
    this.store.query.set((e.target as HTMLInputElement).value);
  }

  follow(e: MouseEvent, link: string): void {
    if (!opensInPlace(e)) return;
    e.preventDefault();
    this.store.open(link);
  }
}
