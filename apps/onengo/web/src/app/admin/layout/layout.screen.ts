import { Component, computed, inject, signal } from '@angular/core';
import { iconLabel } from '@onengo/platform/icons';
import { Icon, PageFrame } from '@onengo/web-kit';
import { t } from '../../core/i18n/i18n';
import { dropIndex, keyMove } from '../../core/ui-logic/reorder';
import { TranslatePipe } from '../../services/i18n';
import { ScreenHeading } from '../../ui/screen-heading';
import { LayoutStore } from './layout-store';

/** The navigation order, each destination's icon, and how wide-screen lists open. */
@Component({
  selector: 'app-admin-layout',
  imports: [ScreenHeading, TranslatePipe, PageFrame, Icon],
  providers: [LayoutStore],
  styleUrl: '../admin.css',
  styles: `
    .layout { display: grid; gap: 16px; }
    .layout__cards { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .layout__card {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 0;
    }
    .layout__card--dragging { opacity: 0.55; }
    .layout__card--drop-before { box-shadow: inset 0 3px 0 var(--brand); }
    .layout__card--drop-after { box-shadow: inset 0 -3px 0 var(--brand); }
    .layout__live {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    .layout__handle {
      display: inline-grid;
      place-items: center;
      width: 32px;
      height: 32px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--muted);
      cursor: grab;
    }
    .layout__handle:hover,
    .layout__handle:focus-visible { background: color-mix(in srgb, var(--brand) 8%, var(--card)); }
    .layout__mark { display: inline-flex; color: var(--brand); }
    .layout__picker { position: relative; }
    .layout__picker-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 9rem;
      text-align: left;
    }
    .layout__picker-panel {
      position: absolute;
      z-index: 6;
      top: calc(100% + 4px);
      left: 0;
      width: min(280px, 70vw);
      padding: 8px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius, 10px);
      box-shadow: var(--card-shadow, 0 8px 24px rgba(15, 23, 42, 0.12));
    }
    .layout__picker-search { width: 100%; margin-bottom: 6px; }
    .layout__picker-list {
      list-style: none;
      margin: 0;
      padding: 0;
      max-height: 240px;
      overflow: auto;
    }
    .layout__picker-option {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      border: 0;
      background: transparent;
      text-align: left;
    }
    .layout__picker-option--on,
    .layout__picker-option:hover { background: color-mix(in srgb, var(--brand) 12%, var(--card)); }
    .layout__name { flex: 1; min-width: 8rem; font-weight: 600; }
    .layout__note { margin: 8px 0 0; font-size: 0.85rem; }
    .layout__add { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .layout__hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="'ui.crumbs.admin.layout' | t" />
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      @if (store.error()) {
        <div class="notice error" role="alert">{{ store.error() }}</div>
      }
      @let d = store.draft();
      <div class="layout">
        <div class="card">
          <fieldset>
            <legend>{{ 'ui.admin.layout.listLayout' | t }}</legend>
            <label><input type="radio" name="list-layout" [checked]="d.listLayout === 'cards'" (change)="store.listLayout('cards')" /> {{ 'ui.admin.layout.cards' | t }}</label>
            <label><input type="radio" name="list-layout" [checked]="d.listLayout === 'table'" (change)="store.listLayout('table')" /> {{ 'ui.admin.layout.table' | t }}</label>
            <p class="muted layout__note">{{ 'ui.admin.layout.listHint' | t }}</p>
          </fieldset>
        </div>
        <section [attr.aria-label]="'ui.admin.layout.navigation' | t">
          <h2 class="admin__caption">{{ 'ui.admin.layout.navigation' | t }}</h2>
          <ul class="layout__cards">
            @for (key of d.items; track key; let i = $index) {
              <li
                class="card layout__card"
                [class.layout__card--dragging]="dragFrom() === i"
                [class.layout__card--drop-before]="dropAt()?.index === i && !dropAt()!.after"
                [class.layout__card--drop-after]="dropAt()?.index === i && dropAt()!.after"
                (dragover)="dragOver($event, i)"
                (dragleave)="dropAt.set(null)"
                (drop)="drop($event, i)">
                <button
                  type="button"
                  class="layout__handle"
                  draggable="true"
                  [attr.aria-label]="('ui.common.move' | t) + ': ' + store.label(key)"
                  (click)="$event.stopPropagation()"
                  (keydown)="handleKey($event, i)"
                  (dragstart)="dragStart($event, i)"
                  (dragend)="dragEnd()">
                  <app-icon name="drag" />
                </button>
                <span class="layout__mark" aria-hidden="true"><app-icon [name]="store.icon(key)" /></span>
                <div class="layout__picker">
                  <button
                    type="button"
                    class="layout__picker-btn"
                    [attr.aria-expanded]="picker() === key"
                    [attr.aria-label]="('ui.admin.layout.icon' | t) + ': ' + store.label(key)"
                    (click)="togglePicker(key)">
                    {{ iconText(store.icon(key)) }}
                  </button>
                  @if (picker() === key) {
                    <div class="layout__picker-panel" (keydown.escape)="picker.set(null)">
                      <input
                        class="layout__picker-search"
                        type="search"
                        [value]="iconQuery()"
                        [attr.aria-label]="'ui.admin.layout.iconSearch' | t"
                        [attr.placeholder]="'ui.admin.layout.iconSearch' | t"
                        (input)="iconQuery.set(searchValue($event))" />
                      <ul class="layout__picker-list" role="listbox" [attr.aria-label]="'ui.admin.layout.icon' | t">
                        @for (name of visibleIcons(); track name) {
                          <li role="presentation">
                            <button
                              type="button"
                              class="layout__picker-option"
                              role="option"
                              [class.layout__picker-option--on]="store.icon(key) === name"
                              [attr.aria-selected]="store.icon(key) === name"
                              (click)="chooseIcon(key, name)">
                              <span class="layout__mark" aria-hidden="true"><app-icon [name]="name" /></span>
                              <span>{{ iconText(name) }}</span>
                            </button>
                          </li>
                        }
                      </ul>
                    </div>
                  }
                </div>
                <span class="layout__name">{{ store.label(key) }}</span>
                @if (store.removable(key) && store.canPublish()) {
                  <button type="button" [attr.aria-label]="('ui.common.remove' | t) + ': ' + store.label(key)" (click)="store.remove(key)">{{ 'ui.common.remove' | t }}</button>
                }
              </li>
            }
          </ul>
          <div class="layout__live" aria-live="polite" aria-atomic="true">{{ moved() }}</div>
          @if (store.recordChoices().length) {
            <label class="layout__add">
              {{ 'ui.admin.layout.addRecord' | t }}
              <select (change)="addRecord($event)">
                <option value=""></option>
                @for (choice of store.recordChoices(); track choice.key) {
                  <option [value]="choice.key">{{ choice.label }}</option>
                }
              </select>
            </label>
          }
          <p class="muted layout__note">{{ 'ui.admin.layout.phoneNote' | t }}</p>
        </section>
        <div class="admin__line">
          <button type="button" [disabled]="!store.canPublish()" (click)="store.discard()">{{ 'ui.admin.layout.discard' | t }}</button>
          <button type="button" class="primary" [disabled]="!store.canPublish()" (click)="store.publish()">{{ 'ui.admin.layout.publish' | t }}</button>
        </div>
      </div>
    </app-page-frame>
  `,
})
export class LayoutScreen {
  readonly store = inject(LayoutStore);
  readonly moved = signal('');
  readonly dragFrom = signal<number | null>(null);
  readonly dropAt = signal<{ index: number; after: boolean } | null>(null);
  readonly picker = signal<string | null>(null);
  readonly iconQuery = signal('');
  readonly visibleIcons = computed(() => {
    const query = this.iconQuery().trim().toLowerCase();
    const names = this.store.iconChoices;
    if (!query) return names;
    return names.filter((name) => name.includes(query) || iconLabel(name).toLowerCase().includes(query));
  });

  iconText(name: string): string {
    return iconLabel(name);
  }

  togglePicker(key: string): void {
    this.iconQuery.set('');
    this.picker.update((open) => (open === key ? null : key));
  }

  searchValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  chooseIcon(key: string, name: string): void {
    this.store.setIcon(key, name);
    this.picker.set(null);
  }

  addRecord(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const key = select.value;
    select.value = '';
    if (key) this.store.addRecord(key);
  }

  handleKey(event: KeyboardEvent, index: number): void {
    const to = keyMove(event.key, true, index, this.store.draft().items.length);
    event.stopPropagation();
    if (to === null) return;
    event.preventDefault();
    this.store.reorder(index, to);
    this.announce(to);
  }

  dragStart(event: DragEvent, index: number): void {
    this.dragFrom.set(index);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  }

  dragOver(event: DragEvent, index: number): void {
    if (this.dragFrom() === null) return;
    event.preventDefault();
    const row = event.currentTarget as HTMLElement;
    const box = row.getBoundingClientRect();
    this.dropAt.set({ index, after: event.clientY > box.top + box.height / 2 });
  }

  drop(event: DragEvent, index: number): void {
    const from = this.dragFrom();
    const at = this.dropAt();
    event.preventDefault();
    this.dragEnd();
    if (from === null) return;
    const to = dropIndex(from, index, at?.index === index && at.after);
    if (to !== from) {
      this.store.reorder(from, to);
      this.announce(to);
    }
  }

  /** Tells a screen reader where the item landed. Clearing first makes a repeat of the same sentence announce again. */
  private announce(to: number): void {
    const items = this.store.draft().items;
    const key = items[to];
    if (!key) return;
    const message = t('ui.admin.layout.moved', { item: this.store.label(key), position: to + 1, count: items.length });
    this.moved.set('');
    queueMicrotask(() => this.moved.set(message));
  }

  dragEnd(): void {
    this.dragFrom.set(null);
    this.dropAt.set(null);
  }
}
