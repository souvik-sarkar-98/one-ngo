import { Component, input, output } from '@angular/core';
import { MatMenuModule } from '@angular/material/menu';

export interface MenuItem {
  id: string;
  label: string;
  /** Drawn with a line above it, starting a new group. */
  group?: boolean;
}

/** A labelled button that opens a menu, such as "+ New". */
@Component({
  selector: 'app-menu-button',
  imports: [MatMenuModule],
  styles: [`.menu-button__group { border-top: 1px solid var(--line, #e2e8f0); }`],
  template: `
    <button type="button" [class.primary]="primary()" [disabled]="disabled()" [matMenuTriggerFor]="menu">{{ label() }}</button>
    <mat-menu #menu="matMenu" xPosition="before">
      @for (item of items(); track item.id) {
        <button type="button" mat-menu-item [class.menu-button__group]="item.group" (click)="choose.emit(item.id)">
          <span>{{ item.label }}</span>
        </button>
      }
    </mat-menu>
  `,
})
export class MenuButton {
  readonly label = input.required<string>();
  readonly items = input.required<MenuItem[]>();
  readonly primary = input(false);
  readonly disabled = input(false);
  readonly choose = output<string>();
}
