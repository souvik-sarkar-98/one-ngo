import { Component, effect, input, output, signal, untracked } from '@angular/core';
import { t } from '../core/i18n/i18n';
import { TranslatePipe } from '../services/i18n';

type Body = Record<string, unknown>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The definition as JSON. Only text that parses to an object is passed on; anything else is shown as a problem. */
@Component({
  selector: 'app-json-editor',
  imports: [TranslatePipe],
  template: `
    <label for="builder-json">{{ 'ui.builder.definition' | t }}</label>
    <textarea id="builder-json" class="code" spellcheck="false" [readOnly]="readOnly()" [value]="text()" (input)="onInput($any($event.target).value)"></textarea>
    @if (problem()) { <div class="error" role="alert">{{ problem() }}</div> }
  `,
})
export class JsonEditor {
  readonly body = input<Body | null>(null);
  readonly readOnly = input(false);
  readonly bodyChange = output<Body>();
  readonly text = signal('');
  readonly problem = signal('');
  private last: Body | null = null;

  constructor() {
    effect(() => {
      const body = this.body();
      untracked(() => {
        if (same(body, this.last)) return;
        this.last = body;
        this.text.set(JSON.stringify(body, null, 2));
        this.problem.set('');
      });
    });
  }

  onInput(text: string): void {
    this.text.set(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('ui.builder.notObject'));
      this.problem.set('');
      this.last = parsed as Body;
      this.bodyChange.emit(parsed as Body);
    } catch (e) {
      this.problem.set((e as Error).message);
    }
  }
}
