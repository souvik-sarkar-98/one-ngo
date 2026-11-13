import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { RowView } from '../core/rows';
import { dropIndex, keyMove } from '../core/ui-logic/reorder';
import { Icon } from '@onengo/web-kit';
import { withDefaults } from './labels';
import type { TableColumn } from './table-rows';

const LABELS = () => ({
  add: t('ui.common.add'),
  remove: t('ui.common.remove'),
  move: t('ui.common.move'),
  close: t('ui.common.close'),
  actions: t('ui.common.actions'),
});

/**
 * A table of definition parts (fields, states, steps, chips, sections…)
 * that people reorder by dragging the ⠿ handle or with the arrow keys on it.
 * Choosing a row opens its panel, whose content the screen projects with
 * the `rowPanel` attribute. Changes are reported, never applied here.
 */
@Component({
  selector: 'app-editable-table',
  imports: [Icon],
  styleUrl: './styles/editable-table.css',
  template: `
    <div class="editable-table" [class.editable-table--with-panel]="!!selected()">
      <div class="editable-table__frame">
        <table class="editable-table__table">
          <thead>
            <tr>
              @if (reorderable()) {
                <th class="editable-table__grip-col"><span class="editable-table__hidden">{{ labels().move }}</span></th>
              }
              @for (c of columns(); track c.key) {
                <th scope="col">{{ c.label }}</th>
              }
              @if (removable()) {
                <th class="editable-table__tool-col"><span class="editable-table__hidden">{{ labels().actions }}</span></th>
              }
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.id; let i = $index) {
              <tr
                class="editable-table__row"
                [class.editable-table__row--selected]="r.id === selectedId()"
                [class.editable-table__row--dragging]="i === dragFrom()"
                [class.editable-table__row--drop-before]="dropAt()?.index === i && !dropAt()!.after"
                [class.editable-table__row--drop-after]="dropAt()?.index === i && dropAt()!.after"
                [attr.data-row-id]="r.id"
                (click)="pick(r.id)"
                (keydown)="rowKey($event, r, i)"
                (dragover)="dragOver($event, i)"
                (dragleave)="dropAt.set(null)"
                (drop)="drop($event, i)"
                tabindex="0">
                @if (reorderable()) {
                  <td class="editable-table__grip">
                    <button
                      type="button"
                      class="editable-table__handle"
                      draggable="true"
                      [attr.data-handle-id]="r.id"
                      [attr.aria-label]="labels().move + ': ' + r.title"
                      (click)="$event.stopPropagation()"
                      (keydown)="handleKey($event, r, i)"
                      (dragstart)="dragStart($event, i)"
                      (dragend)="dragEnd()">
                      <app-icon name="drag" />
                    </button>
                  </td>
                }
                @for (c of columns(); track c.key; let first = $first) {
                  <td [class.editable-table__title]="first">
                    @if (c.key === badgeKey() && r.badge) {
                      <span [class]="'editable-table__badge editable-table__badge--' + r.badge.tone">{{ r.badge.label }}</span>
                    } @else if (r.cellBadges?.[c.key]?.length) {
                      <span class="editable-table__badges">
                        @for (b of r.cellBadges![c.key]; track $index) { <span [class]="'editable-table__badge editable-table__badge--' + b.tone">{{ b.label }}</span> }
                      </span>
                    } @else {
                      {{ cell(r, c.key) }}
                    }
                  </td>
                }
                @if (removable()) {
                  <td class="editable-table__tool">
                    <button type="button" class="editable-table__icon-btn" [attr.aria-label]="labels().remove + ': ' + r.title" (click)="$event.stopPropagation(); remove.emit(r.id)">
                      <app-icon name="delete" />
                    </button>
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
        @if (addable()) {
          <button type="button" class="editable-table__add" (click)="add.emit()">
            <app-icon name="add" />
            <span>{{ labels().add }}</span>
          </button>
        }
      </div>
      @if (selected(); as s) {
        <aside class="editable-table__panel" [attr.aria-label]="s.title">
          <div class="editable-table__panel-head">
            <h3 class="editable-table__panel-title">{{ s.title }}</h3>
            <button type="button" class="editable-table__icon-btn" [attr.aria-label]="labels().close" (click)="close()">
              <app-icon name="close" />
            </button>
          </div>
          <ng-content select="[rowPanel]"></ng-content>
        </aside>
      }
    </div>
  `,
})
export class EditableTable {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly rows = input.required<RowView[]>();
  readonly columns = input.required<TableColumn[]>();
  readonly selectedId = input<string | null>(null);
  readonly badgeKey = input('');
  readonly reorderable = input(true);
  readonly addable = input(true);
  readonly removable = input(true);
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  /**
   * Not called `select`: that is also the name of the browser event fired when
   * text is selected (double-clicking a word in an input), which bubbles up
   * here and would be taken for a row choice.
   */
  readonly rowSelect = output<string | null>();
  readonly moved = output<{ from: number; to: number }>();
  readonly add = output<void>();
  readonly remove = output<string>();

  readonly dragFrom = signal<number | null>(null);
  readonly dropAt = signal<{ index: number; after: boolean } | null>(null);
  readonly selected = computed(() => this.rows().find((r) => r.id === this.selectedId()) ?? null);
  private refocus: string | null = null;
  constructor() {
    effect(() => {
      this.rows();
      const id = untracked(() => this.refocus);
      if (!id) return;
      this.refocus = null;
      queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-handle-id="${CSS.escape(id)}"]`)?.focus());
    });
  }

  cell(r: RowView, key: string): string {
    return r.cells.find((c) => c.key === key)?.value ?? (key === 'title' ? r.title : '');
  }

  handleKey(e: KeyboardEvent, r: RowView, index: number): void {
    const to = keyMove(e.key, true, index, this.rows().length);
    e.stopPropagation();
    if (to === null) return;
    e.preventDefault();
    this.refocus = r.id;
    this.moved.emit({ from: index, to });
  }

  rowKey(e: KeyboardEvent, r: RowView, index: number): void {
    if (e.target !== e.currentTarget) return;
    const to = this.reorderable() ? keyMove(e.key, e.altKey, index, this.rows().length) : null;
    if (to !== null) {
      e.preventDefault();
      this.refocus = r.id;
      this.moved.emit({ from: index, to });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.pick(r.id);
    }
  }

  /** Opens a row's panel. */
  pick(id: string): void {
    this.rowSelect.emit(id);
  }

  /** Only the panel's close button closes it. */
  close(): void {
    this.rowSelect.emit(null);
  }

  dragStart(e: DragEvent, index: number): void {
    this.dragFrom.set(index);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
  }

  dragOver(e: DragEvent, index: number): void {
    if (this.dragFrom() === null) return;
    e.preventDefault();
    const row = e.currentTarget as HTMLElement;
    const box = row.getBoundingClientRect();
    this.dropAt.set({ index, after: e.clientY > box.top + box.height / 2 });
  }

  drop(e: DragEvent, index: number): void {
    const from = this.dragFrom();
    const at = this.dropAt();
    e.preventDefault();
    this.dragEnd();
    if (from === null) return;
    const to = dropIndex(from, index, at?.index === index && at.after);
    if (to !== from) this.moved.emit({ from, to });
  }

  dragEnd(): void {
    this.dragFrom.set(null);
    this.dropAt.set(null);
  }
}
