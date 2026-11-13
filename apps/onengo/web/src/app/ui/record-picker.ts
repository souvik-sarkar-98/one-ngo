import { Component, computed, input, viewChild } from '@angular/core';
import type { PickOption } from '../core/records/record/references';
import type { Suggestion, SuggestionSource } from '../core/ui-logic/autocomplete';
import { TranslatePipe } from '../services/i18n';
import { Autocomplete } from './autocomplete';
import type { CfFieldDef } from './cf-types';

const NOTHING: SuggestionSource = { search: async () => [] };

/**
 * A reference or person field: type to search, choose a suggestion (with its
 * second line), or "New <type> “text”" where offered; ✕ clears the choice.
 * The box shows the chosen record's title or the person's name.
 */
@Component({
  selector: 'app-record-picker',
  imports: [Autocomplete, TranslatePipe],
  styles: `
    :host {
      display: block;
    }
    .record-picker__box {
      position: relative;
    }
    .record-picker__clear {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: #49454f;
      font: inherit;
      cursor: pointer;
    }
    .record-picker__clear:hover,
    .record-picker__clear:focus-visible {
      background: #eef3f8;
    }
  `,
  template: `
    @let f = field();
    <div class="cf-field-block record-picker" [attr.data-cf-field]="f.key" data-cf-type="picker">
      <label class="cf-field-label" [for]="box.id">
        {{ f.label }}
        @if (f.required) {
          <span class="cf-required-mark" aria-hidden="true"> *</span>
        }
      </label>
      <div class="record-picker__box" (focusout)="restore()">
        <app-autocomplete #box [source]="source()" [text]="text()" [placeholder]="f.placeholder ?? ''" [disabled]="locked()" [delay]="250" (chosen)="choose($event)" />
        @if (value() && !locked()) {
          <button type="button" class="record-picker__clear" [attr.aria-label]="'ui.records.clearChoice' | t: { field: f.label }" (click)="f.picker!.clear()">✕</button>
        }
      </div>
      @if (f.hint) {
        <div class="cf-field-hint">{{ f.hint }}</div>
      }
      @if (error()) {
        <div class="cf-field-error mat-mdc-form-field-error" role="alert">{{ error() }}</div>
      }
    </div>
  `,
})
export class RecordPicker {
  readonly field = input.required<CfFieldDef>();
  /** The chosen id, '' when nothing is chosen. */
  readonly value = input('');
  readonly error = input<string | undefined>();

  private readonly box = viewChild.required(Autocomplete);
  readonly source = computed(() => this.field().picker?.source ?? NOTHING);
  readonly text = computed(() => this.field().picker?.text ?? this.value());
  readonly locked = computed(() => this.field().readOnly || !this.field().picker);

  choose(option: Suggestion): void {
    const create = (option as PickOption).create;
    if (create !== undefined) this.box().session.setText(create);
    this.field().picker?.choose(option);
  }

  /** Leaving the box without choosing shows the current choice again. */
  restore(): void {
    this.box().session.setText(this.text());
  }
}
