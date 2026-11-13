import { Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/** The round create (+) button, as the list toolkit drew it. Place it in the list's floating actions. */
@Component({
  selector: 'app-create-button',
  imports: [MatIconModule],
  styleUrl: './styles/na-list-dashboard.css',
  template: `
    <button type="button" class="app-btn app-btn--primary list-dashboard__fab" [attr.aria-label]="label()" [attr.title]="label()" (click)="pressed.emit()">
      <mat-icon>add</mat-icon>
    </button>
  `,
})
export class CreateButton {
  readonly label = input.required<string>();
  readonly pressed = output<void>();
}
