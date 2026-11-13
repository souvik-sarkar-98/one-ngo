import { Component, input } from '@angular/core';

/** A form-level message and problems that do not belong to one field. */
@Component({
  selector: 'app-form-problems',
  template: `
    @if (message() || problems().length) {
      <div class="notice form-problems" [class.error]="tone() === 'error'" [class.ok]="tone() === 'ok'" [attr.role]="tone() === 'error' ? 'alert' : 'status'">
        @if (message()) { <div>{{ message() }}</div> }
        @if (problems().length) {
          <ul>@for (problem of problems(); track $index) { <li>{{ problem }}</li> }</ul>
        }
      </div>
    }
  `,
  styles: `:host{display:block;flex-shrink:0}.form-problems{margin:0 0 10px}`,
})
export class FormProblems {
  readonly message = input('');
  readonly problems = input<string[]>([]);
  readonly tone = input<'error' | 'ok'>('error');
}
