import { Component, computed, inject, input, output } from '@angular/core';
import type { FormColumns } from '../core/models';
import type { FormValue, FormValues } from '../core/records/record/forms';
import { TranslatePipe } from '../services/i18n';
import { CfField } from './cf-field';
import type { CfFieldDef } from './cf-types';
import { drawnColumns } from './form-grid';
import { Viewport } from './viewport';

/** A form of fields, drawn as the list toolkit drew it. The host owns the values. */
@Component({
  selector: 'cf-form',
  imports: [CfField],
  styleUrl: './styles/cf-form.css',
  template: `
    <form class="cf-form mat-typography" (submit)="$event.preventDefault()" novalidate>
      <div
        class="cf-form-step"
        [attr.data-columns]="drawn()"
        [style.display]="'grid'"
        [style.grid-template-columns]="'repeat(' + drawn() + ', minmax(0, 1fr))'"
        [style.column-gap]="'1rem'">
        @for (field of fields(); track field.key) {
          <cf-field
            [style.grid-column]="wide().has(field.key) ? '1 / -1' : null"
            [field]="field"
            [fieldId]="idPrefix() + '-' + field.key"
            [values]="values()"
            [error]="errors()[field.key]"
            (valueChange)="set($event.key, $event.value)"
          />
        }
      </div>
    </form>
  `,
})
export class CfForm {
  readonly fields = input.required<CfFieldDef[]>();
  readonly values = input.required<FormValues>();
  readonly errors = input<Record<string, string>>({});
  readonly idPrefix = input('cf');
  /** Columns on wide screens; phones always draw one. */
  readonly columns = input<FormColumns>(1);
  /** Fields that take a whole row, whatever the column count. */
  readonly fullWidth = input<readonly string[]>([]);
  readonly valuesChange = output<FormValues>();

  private readonly viewport = inject(Viewport);
  readonly drawn = computed(() => drawnColumns(this.columns(), this.viewport.narrow()));
  readonly wide = computed(() => new Set(this.fullWidth()));

  set(key: string, value: FormValue): void {
    this.valuesChange.emit({ ...this.values(), [key]: value });
  }
}

/** The header and form of one create step; the buttons sit in the sheet footer. */
@Component({
  selector: 'cf-form-stepper',
  imports: [CfForm, TranslatePipe],
  styleUrl: './styles/cf-form-stepper.css',
  template: `
    <div class="cf-form-stepper">
      <div class="cf-form-stepper__header">
        <h3 class="cf-form-stepper__title">{{ stepLabel() }}</h3>
        <span class="cf-form-stepper__progress">
          {{ 'ui.records.stepProgress' | t: { step: stepIndex() + 1, count: stepCount() } }}
        </span>
      </div>
      <cf-form
        class="cf-form-stepper__form"
        [fields]="fields()"
        [values]="values()"
        [errors]="errors()"
        [idPrefix]="idPrefix()"
        [columns]="columns()"
        [fullWidth]="fullWidth()"
        (valuesChange)="valuesChange.emit($event)">
      </cf-form>
    </div>
  `,
})
export class CfFormStepper {
  readonly stepLabel = input.required<string>();
  readonly stepIndex = input.required<number>();
  readonly stepCount = input.required<number>();
  readonly fields = input.required<CfFieldDef[]>();
  readonly values = input.required<FormValues>();
  readonly errors = input<Record<string, string>>({});
  readonly idPrefix = input('cf');
  readonly columns = input<FormColumns>(1);
  readonly fullWidth = input<readonly string[]>([]);
  readonly valuesChange = output<FormValues>();
}
