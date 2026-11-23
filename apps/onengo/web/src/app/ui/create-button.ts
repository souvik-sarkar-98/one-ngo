import { Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Btn } from '@onengo/web-kit';

/** The round create (+) button, as the list toolkit drew it. Place it in the list's floating actions. */
@Component({
  selector: 'app-create-button',
  imports: [Btn, MatIconModule],
  styleUrl: './styles/na-list-dashboard.css',
  template: `
    <button appBtn="primary" type="button" class="list-dashboard__fab" [attr.aria-label]="label()" [attr.title]="label()" (click)="pressed.emit()">
      <mat-icon>add</mat-icon>
    </button>
  `,
})
export class CreateButton {
  readonly label = input.required<string>();
  readonly pressed = output<void>();
}
