import { Component, input, output } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { SuggestionSource } from '../core/ui-logic/autocomplete';
import { Autocomplete } from './autocomplete';
import { withDefaults } from './labels';

const LABELS = () => ({ placeholder: t('ui.permissionField.placeholder') });

/**
 * A permission such as `record:donation:read`: suggests the permissions the
 * organisation has and uses, and still takes a new one typed in full.
 */
@Component({
  selector: 'app-permission-field',
  imports: [Autocomplete],
  template: `
    <app-autocomplete
      [label]="label()"
      [text]="value()"
      [source]="source()"
      [placeholder]="labels().placeholder"
      [disabled]="disabled()"
      (typed)="valueChange.emit($event)"
      (chosen)="valueChange.emit($event.id)" />
    @if (hint()) {
      <div class="permission-field__hint">{{ hint() }}</div>
    }
  `,
  styles: `
    :host { display: block; }
    .permission-field__hint { color: var(--muted); font-size: .85rem; margin-top: .2rem; }
  `,
})
export class PermissionField {
  readonly value = input('');
  readonly source = input.required<SuggestionSource>();
  readonly label = input('');
  readonly hint = input('');
  readonly disabled = input(false);
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  readonly valueChange = output<string>();
}
