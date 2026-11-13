import { Component, computed, input, output, signal } from '@angular/core';
import { moveItem } from '../../../core/ui-logic/reorder';
import { TranslatePipe } from '../../../services/i18n';

export interface FieldOption {
  key: string;
  label: string;
}

/** A field dragged from one pill list onto another, e.g. between create steps. */
export interface FieldDrop {
  field: string;
  from: string;
  index: number;
}

const DRAG_TYPE = 'application/x-ngo-field';

/**
 * Field keys as pills in order: drag a pill to reorder it (or onto another
 * list with a `group`), ✕ removes it, and the menu adds one of the options
 * not yet chosen. Changes are reported, never applied here.
 */
@Component({
  selector: 'app-field-pills',
  imports: [TranslatePipe],
  styleUrl: './list-view.css',
  template: `
    <div class="lv-pills" role="group" [attr.aria-label]="label()" (dragover)="over($event)" (drop)="drop($event, keys().length)">
      @for (k of keys(); track k; let i = $index) {
        <span
          class="lv-pill"
          draggable="true"
          [class.lv-pill--drop]="dropAt() === i"
          (dragstart)="start($event, k)"
          (dragend)="dropAt.set(null)"
          (dragover)="over($event, i)"
          (drop)="drop($event, i)">
          <span class="lv-pill__grip" aria-hidden="true">⠿</span>{{ labelOf(k) }}
          <button type="button" class="lv-pill__btn" [attr.aria-label]="('ui.builder.moveUp' | t) + ': ' + labelOf(k)" [disabled]="i === 0" (click)="changed.emit(moved(i, i - 1))">‹</button>
          <button type="button" class="lv-pill__btn" [attr.aria-label]="('ui.common.remove' | t) + ': ' + labelOf(k)" (click)="changed.emit(without(k))">✕</button>
        </span>
      }
      @if (addable().length && keys().length < max()) {
        <select class="lv-pills__add" [attr.aria-label]="addLabel() || ('ui.builder.listView.addField' | t)" (change)="add($event)">
          <option value="" selected>{{ addLabel() || ('ui.builder.listView.addField' | t) }}</option>
          @for (o of addable(); track o.key) { <option [value]="o.key">{{ o.label }}</option> }
        </select>
      }
    </div>
  `,
})
export class FieldPills {
  readonly keys = input.required<readonly string[]>();
  readonly options = input.required<readonly FieldOption[]>();
  readonly label = input('');
  readonly addLabel = input('');
  readonly max = input(Infinity);
  /** Lists in the same group take each other's pills; `id` names this one. */
  readonly group = input('');
  readonly id = input('');
  readonly changed = output<string[]>();
  readonly received = output<FieldDrop>();

  readonly dropAt = signal<number | null>(null);
  readonly addable = computed(() => this.options().filter((o) => !this.keys().includes(o.key)));

  labelOf(key: string): string {
    return this.options().find((o) => o.key === key)?.label ?? key;
  }

  moved(from: number, to: number): string[] {
    return moveItem(this.keys(), from, to);
  }

  without(key: string): string[] {
    return this.keys().filter((k) => k !== key);
  }

  add(e: Event): void {
    const select = e.target as HTMLSelectElement;
    if (select.value) this.changed.emit([...this.keys(), select.value]);
    select.value = '';
  }

  start(e: DragEvent, field: string): void {
    e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify({ field, group: this.group(), from: this.id() }));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  over(e: DragEvent, index?: number): void {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    if (index !== undefined) {
      e.stopPropagation();
      this.dropAt.set(index);
    }
  }

  drop(e: DragEvent, index: number): void {
    const raw = e.dataTransfer?.getData(DRAG_TYPE);
    this.dropAt.set(null);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const { field, group, from } = JSON.parse(raw) as { field: string; group: string; from: string };
    if (from === this.id() && group === this.group()) {
      const at = this.keys().indexOf(field);
      if (at >= 0) this.changed.emit(moveItem(this.keys(), at, Math.min(at < index ? index - 1 : index, this.keys().length - 1)));
    } else if (group && group === this.group()) {
      this.received.emit({ field, from, index });
    }
  }
}
