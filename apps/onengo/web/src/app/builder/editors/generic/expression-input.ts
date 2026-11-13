import { Component, computed, inject, input, output } from '@angular/core';
import type { ExpressionContext } from '../../../core/builder/expression-catalogue';
import { ExpressionField } from '../../../ui/expression-field';
import { BuilderStore } from '../../builder-store';

const CONTEXTS: Partial<Record<string, ExpressionContext>> = {
  action: 'action',
  automation: 'automation',
  template: 'template',
  postingRule: 'posting',
};

/** Every `x-expression` property of the generic editor; `recordType` is the record type the expression is written for. */
@Component({
  selector: 'app-expression-input',
  imports: [ExpressionField],
  template: `
    <app-expression-field
      [assist]="store.expressions"
      [recordType]="recordType() || null"
      [context]="context()"
      [label]="label()"
      [hint]="hint()"
      [panelTitle]="label()"
      [value]="value()"
      (valueChange)="valueChange.emit($event)"
    />
  `,
  styles: `
    :host { display: block; }
  `,
})
export class ExpressionInput {
  protected readonly store = inject(BuilderStore);
  readonly fieldId = input.required<string>();
  readonly label = input('');
  readonly hint = input('');
  readonly value = input('');
  readonly recordType = input('');
  readonly valueChange = output<string>();
  protected readonly context = computed<ExpressionContext>(() => CONTEXTS[this.store.state()?.kind ?? ''] ?? 'record');
}
