import { Component, input, output } from '@angular/core';
import type { ChipSpec } from '../core/records/spec';
import { TranslatePipe } from '../services/i18n';

@Component({
  selector: 'app-chip-filter-bar',
  imports: [TranslatePipe],
  styleUrl: './styles/app-chip-filter-bar.css',
  template: `
    <div class="chip-bar" role="tablist" [attr.aria-label]="'ui.common.filters' | t">
      @for (chip of chips(); track chip.id) {
        <button
          type="button"
          class="chip-bar__chip"
          role="tab"
          [class.chip-bar__chip--active]="chip.id === activeId()"
          [attr.aria-selected]="chip.id === activeId()"
          (click)="select(chip.id)">
          {{ chip.label }}
        </button>
      }
    </div>
  `,
})
export class ChipFilterBar {
  readonly chips = input.required<ChipSpec[]>();
  readonly activeId = input('');
  readonly chipSelect = output<string>();

  select(id: string): void {
    if (id !== this.activeId()) this.chipSelect.emit(id);
  }
}
