import { Component, input, output } from '@angular/core';
import { Btn } from './btn.js';
import { DialogFocus } from './dialog-focus.js';

let nextId = 0;

/**
 * A question that must be answered before the page behind it can be used, such as signing out. Focus
 * moves into it, Tab stays inside, the page behind is inert, a click on the backdrop does nothing and
 * Escape cancels. The apps give it their own words.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [Btn, DialogFocus],
  styleUrl: './confirm-dialog.css',
  template: `
    <div class="confirm" data-dialog-shade role="presentation">
      <div class="confirm__card" appDialog role="alertdialog" [attr.aria-labelledby]="id + '-title'" [attr.aria-describedby]="id + '-text'" (escape)="cancel.emit()">
        <h2 [id]="id + '-title'">{{ title() }}</h2>
        <p [id]="id + '-text'">{{ text() }}</p>
        <div class="confirm__acts">
          <button type="button" appBtn (click)="cancel.emit()">{{ cancelLabel() }}</button>
          <button type="button" [appBtn]="destructive() ? 'destructive' : 'primary'" [disabled]="busy()" (click)="confirm.emit()">{{ confirmLabel() }}</button>
        </div>
      </div>
    </div>
  `,
})
export class ConfirmDialog {
  readonly id = `confirm-${nextId++}`;
  readonly title = input.required<string>();
  readonly text = input('');
  readonly confirmLabel = input.required<string>();
  readonly cancelLabel = input('Cancel');
  /** The confirm button is solid red: the step cannot be undone. */
  readonly destructive = input(true);
  /** The confirm is under way; its button is off so it cannot be pressed twice. */
  readonly busy = input(false);
  readonly confirm = output<void>();
  readonly cancel = output<void>();
}
