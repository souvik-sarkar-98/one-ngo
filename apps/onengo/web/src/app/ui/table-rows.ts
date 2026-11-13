import { Component, computed, input, output } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { RowView } from '../core/rows';
import { withDefaults } from './labels';
import { RowMenu } from './row-menu';
import { opensRow } from './row-keys';

export interface TableColumn {
  key: string;
  label: string;
  sortable?: boolean;
}

export interface TableSort {
  field: string;
  dir: 'asc' | 'desc';
}

const LABELS = () => ({ actions: t('ui.common.actions'), more: t('ui.common.moreActions'), select: t('ui.bulk.select'), selectAll: t('ui.bulk.selectAll') });

/**
 * Rows as a table, drawn to sit inside the list panel: sortable column
 * headers (ascending, descending, cleared — the list decides) and the ⋮ row
 * menu. The first column is drawn in bold.
 */
@Component({
  selector: 'app-table-rows',
  imports: [RowMenu],
  styleUrl: './styles/table-rows.css',
  styles: `
    .table-rows__buttons {
      display: inline-flex;
      gap: 6px;
      white-space: nowrap;
    }
    .table-rows__buttons .app-btn {
      padding: 0.3rem 0.7rem;
      font-size: 0.75rem;
    }
    .table-rows .table-rows__check {
      width: 1%;
      padding-right: 0;
    }
    .table-rows__row--checked td {
      background: var(--primary-100, #e0ecf5);
    }
  `,
  template: `
    <table class="table-rows">
      <thead>
        <tr>
          @if (checked()) {
            <th class="table-rows__check">
              <input
                type="checkbox"
                [checked]="pageTicked() === 'all'"
                [indeterminate]="pageTicked() === 'some'"
                [attr.aria-label]="labels().selectAll"
                (change)="checkPage.emit()" />
            </th>
          }
          @for (c of columns(); track c.key) {
            <th scope="col" [attr.aria-sort]="ariaSort(c.key)">
              @if (c.sortable) {
                <button type="button" class="table-rows__sort" (click)="sortToggle.emit(c.key)">
                  {{ c.label }}
                  @if (sort()?.field === c.key) {
                    <span class="table-rows__dir" aria-hidden="true">{{ sort()!.dir === 'asc' ? '▲' : '▼' }}</span>
                  }
                </button>
              } @else {
                {{ c.label }}
              }
            </th>
          }
          @if (hasActions()) {
            <th class="table-rows__menu-col"><span class="table-rows__hidden">{{ labels().actions }}</span></th>
          }
        </tr>
      </thead>
      <tbody>
        @for (r of rows(); track r.id) {
          <tr
            class="table-rows__row"
            tabindex="0"
            [class.table-rows__row--selected]="r.id === selectedId()"
            [class.table-rows__row--checked]="checked()?.has(r.id)"
            [attr.data-row-id]="r.id"
            (click)="rowClick.emit(r)"
            (keydown)="key($event, r)">
            @if (checked(); as ticked) {
              <td class="table-rows__check" (click)="$event.stopPropagation()">
                <input type="checkbox" [checked]="ticked.has(r.id)" [attr.aria-label]="labels().select + ' ' + r.title" (change)="check.emit(r.id)" />
              </td>
            }
            @for (c of columns(); track c.key; let first = $first) {
              <td [class.table-rows__title]="first">
                @if (c.key === badgeKey() && r.badge) {
                  <span [class]="'table-rows__badge table-rows__badge--' + r.badge.tone">{{ r.badge.label }}</span>
                } @else {
                  {{ cell(r, c.key) }}
                }
              </td>
            }
            @if (hasActions()) {
              <td class="table-rows__menu">
                @if (inlineActions()) {
                  <span class="table-rows__buttons">
                    @for (a of r.actions; track a.id) {
                      <button
                        type="button"
                        class="app-btn"
                        [class.app-btn--primary]="a.tone === 'primary'"
                        [class.danger]="a.tone === 'danger'"
                        [disabled]="actionsDisabled()"
                        (click)="$event.stopPropagation(); rowAction.emit({ row: r, action: a.id })">
                        {{ a.label }}
                      </button>
                    }
                  </span>
                } @else if (r.actions.length) {
                  <app-row-menu [actions]="r.actions" [labels]="{ more: labels().more }" (choose)="rowAction.emit({ row: r, action: $event })" />
                }
              </td>
            }
          </tr>
        }
      </tbody>
    </table>
  `,
})
export class TableRows {
  readonly rows = input.required<RowView[]>();
  readonly columns = input.required<TableColumn[]>();
  readonly sort = input<TableSort | undefined>();
  readonly selectedId = input<string | null>(null);
  /** The column whose cell shows the row's badge, usually the status. */
  readonly badgeKey = input<string>('status');
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  /** Draws each row's actions as buttons instead of the ⋮ menu. */
  readonly inlineActions = input(false);
  readonly actionsDisabled = input(false);
  /** The ticked rows; when set, a checkbox column comes first. */
  readonly checked = input<ReadonlySet<string> | null>(null);
  readonly rowClick = output<RowView>();
  readonly rowAction = output<{ row: RowView; action: string }>();
  readonly sortToggle = output<string>();
  readonly check = output<string>();
  readonly checkPage = output<void>();

  readonly hasActions = computed(() => this.rows().some((r) => r.actions.length));
  readonly pageTicked = computed(() => {
    const ticked = this.checked();
    const n = ticked ? this.rows().filter((r) => ticked.has(r.id)).length : 0;
    return n === 0 ? 'none' : n === this.rows().length ? 'all' : 'some';
  });

  ariaSort(key: string): string | null {
    const s = this.sort();
    return s?.field === key ? (s.dir === 'asc' ? 'ascending' : 'descending') : null;
  }

  cell(r: RowView, key: string): string {
    return r.cells.find((c) => c.key === key)?.value ?? '—';
  }

  key(e: KeyboardEvent, r: RowView): void {
    if (e.target !== e.currentTarget || !opensRow(e)) return;
    e.preventDefault();
    this.rowClick.emit(r);
  }
}
