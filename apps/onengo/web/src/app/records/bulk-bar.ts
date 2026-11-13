import { Component, computed, inject } from '@angular/core';
import { MAX_SELECTED } from '../core/records/bulk/selection';
import { TranslatePipe } from '../services/i18n';
import { RowMenu } from '../ui/row-menu';
import { BulkStore } from './bulk-store';
import { ListStore } from './list-store';

/**
 * The bulk bar while rows are selected: the count, Clear selection, "Select
 * all N that match", and the operations allowed for every selected record.
 * Phones keep the first operation and put the rest under ⋮.
 */
@Component({
  selector: 'app-bulk-bar',
  imports: [RowMenu, TranslatePipe],
  styleUrl: '../ui/styles/app-filtered-infinite-list.css',
  styles: `
    :host {
      display: block;
      max-width: min(760px, calc(100vw - 32px));
    }
    .filtered-infinite-list__bulk-bar {
      margin-bottom: 0;
      flex-wrap: wrap;
    }
    .filtered-infinite-list__bulk-meta {
      flex-wrap: wrap;
    }
    .bulk-bar__note {
      font-size: 0.68rem;
      color: var(--secondary-500);
    }
  `,
  template: `
    <div class="filtered-infinite-list__bulk-bar" role="region" [attr.aria-label]="'ui.bulk.selected' | t: { count: bulk.count() }">
      <div class="filtered-infinite-list__bulk-meta">
        <button type="button" class="filtered-infinite-list__bulk-clear" [attr.aria-label]="'ui.bulk.clear' | t" (click)="bulk.clear()">✕</button>
        <span class="filtered-infinite-list__bulk-count" aria-live="polite">{{ 'ui.bulk.selected' | t: { count: bulk.count() } }}</span>
        @if (bulk.selection().all) {
          <span class="bulk-bar__note">{{ 'ui.bulk.allSelected' | t: { count: bulk.count() } }}</span>
        } @else if (bulk.offer() === 'offer') {
          <button type="button" class="filtered-infinite-list__bulk-clear" (click)="bulk.selectAllMatching()">{{ 'ui.bulk.allMatching' | t: { count: bulk.total() } }}</button>
        } @else if (bulk.offer() === 'tooMany') {
          <span class="bulk-bar__note">{{ 'ui.bulk.tooMany' | t: { count: max } }}</span>
        }
      </div>
      @if (bulk.count()) {
        <div class="filtered-infinite-list__bulk-actions">
          @for (op of shown(); track op.id) {
            <button type="button" class="app-btn" [class.app-btn--primary]="$first" (click)="bulk.run(op)">{{ op.label }}</button>
          }
          @if (rest().length) {
            <app-row-menu [actions]="rest()" (choose)="choose($event)" />
          }
        </div>
      }
    </div>
  `,
})
export class BulkBar {
  readonly bulk = inject(BulkStore);
  private readonly list = inject(ListStore);
  readonly max = MAX_SELECTED;

  readonly shown = computed(() => this.bulk.operations().slice(0, this.list.narrow() ? 1 : undefined));
  readonly rest = computed(() => (this.list.narrow() ? this.bulk.operations().slice(1) : []));

  choose(id: string): void {
    const op = this.bulk.operations().find((o) => o.id === id);
    if (op) this.bulk.run(op);
  }
}
