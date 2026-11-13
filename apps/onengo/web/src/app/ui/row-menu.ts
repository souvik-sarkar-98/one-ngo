import { Component, input, output } from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { t } from '../core/i18n/i18n';
import { withDefaults } from './labels';

const LABELS = () => ({ more: t('ui.common.moreActions') });

/**
 * The ⋮ row menu, the same in every list: the button the list toolkit drew
 * (or the plain table's small button) and a menu of the row's actions.
 */
@Component({
  selector: 'app-row-menu',
  imports: [MatMenuModule, MatIconModule, MatDividerModule],
  styleUrl: './styles/na-list-dashboard.css',
  template: `
    @if (look() === 'table') {
      <button
        type="button"
        class="small"
        [attr.aria-label]="labels().more"
        [matMenuTriggerFor]="menu"
        (click)="$event.stopPropagation()"
        (keydown)="$event.stopPropagation()">
        ⋮
      </button>
    } @else {
      <button type="button" class="list-dashboard__row-menu-btn" [attr.aria-label]="labels().more" [matMenuTriggerFor]="menu" (click)="$event.stopPropagation()">
        <mat-icon>more_vert</mat-icon>
      </button>
    }
    <mat-menu #menu="matMenu" xPosition="before">
      @for (a of actions(); track a.id) {
        @if (a.divider) {
          <mat-divider />
        }
        <button type="button" mat-menu-item (click)="choose.emit(a.id)">
          <span>{{ a.label }}</span>
        </button>
      }
    </mat-menu>
  `,
})
export class RowMenu {
  readonly actions = input.required<{ id: string; label: string; divider?: boolean }[]>();
  readonly look = input<'card' | 'table'>('card');
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  readonly choose = output<string>();
}
