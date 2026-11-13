import { Component, input, output } from '@angular/core';
import type { FilterPill } from '../core/records/record/present';
import { TranslatePipe } from '../services/i18n';

@Component({
  selector: 'app-applied-filter-pills',
  imports: [TranslatePipe],
  styleUrl: './styles/app-applied-filter-pills.css',
  template: `
    @if (filters().length) {
      <div class="applied-filter-pills">
        @for (filter of filters(); track filter.id) {
          <button
            type="button"
            class="applied-filter-pills__pill"
            (click)="remove.emit(filter.id)"
            [attr.aria-label]="'ui.records.removeFilter' | t: { filter: filter.label }">
            <span>{{ filter.label }}</span>
            <span class="applied-filter-pills__close" aria-hidden="true">&times;</span>
          </button>
        }
      </div>
    }
  `,
})
export class AppliedFilterPills {
  readonly filters = input.required<FilterPill[]>();
  readonly remove = output<string>();
}
