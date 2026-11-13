import { Component, DestroyRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import { t } from '../core/i18n/i18n';
import { AutocompleteSession, type AutocompleteState, type Suggestion, type SuggestionSource } from '../core/ui-logic/autocomplete';
import { withDefaults } from './labels';

const LABELS = () => ({ loading: t('ui.common.searching'), empty: t('ui.common.noMatches'), error: t('ui.common.suggestionsFailed') });
let nextId = 0;

/**
 * A text box that suggests as you type, from any source: records, definition
 * keys, roles or a fixed list. Arrow keys move through the suggestions, Enter
 * chooses, Escape closes.
 */
@Component({
  selector: 'app-autocomplete',
  styleUrl: './styles/autocomplete.css',
  template: `
    @let s = state();
    <div class="autocomplete" [class.autocomplete--open]="s.open">
      @if (label()) {
        <label class="autocomplete__label" [attr.for]="id">{{ label() }}</label>
      }
      <input
        class="autocomplete__input"
        type="text"
        role="combobox"
        autocomplete="off"
        [id]="id"
        [value]="s.text"
        [placeholder]="placeholder()"
        [disabled]="disabled()"
        [attr.aria-expanded]="s.open"
        [attr.aria-controls]="id + '-list'"
        aria-autocomplete="list"
        [attr.aria-activedescendant]="s.open && s.active >= 0 ? id + '-' + s.active : null"
        (input)="input($any($event.target).value)"
        (focus)="session.focus()"
        (keydown)="key($event)"
        (blur)="session.close()" />
      @if (s.open) {
        <ul class="autocomplete__list" role="listbox" [id]="id + '-list'">
          @for (o of s.options; track o.id; let i = $index) {
            <li
              class="autocomplete__option"
              role="option"
              [id]="id + '-' + i"
              [class.autocomplete__option--active]="i === s.active"
              [attr.aria-selected]="i === s.active"
              (mousedown)="$event.preventDefault()"
              (mouseenter)="session.highlight(i)"
              (click)="pick(i)">
              <span class="autocomplete__option-label">{{ o.label }}</span>
              @if (o.hint) {
                <span class="autocomplete__option-hint">{{ o.hint }}</span>
              }
            </li>
          }
          @if (s.loading) {
            <li class="autocomplete__state" role="status">{{ labels().loading }}</li>
          } @else if (s.error) {
            <li class="autocomplete__state autocomplete__state--error" role="alert">{{ labels().error }}</li>
          } @else if (!s.options.length && s.text.trim()) {
            <li class="autocomplete__state" role="status">{{ labels().empty }}</li>
          }
        </ul>
      }
    </div>
  `,
})
export class Autocomplete {
  readonly source = input.required<SuggestionSource>();
  /** The shown text, e.g. the chosen value's label; typing replaces it. */
  readonly text = input('');
  readonly label = input('');
  readonly placeholder = input('');
  readonly disabled = input(false);
  /** Milliseconds after typing stops before the source is asked. */
  readonly delay = input(300);
  readonly labels = input(LABELS(), { transform: withDefaults(LABELS) });
  readonly chosen = output<Suggestion>();
  readonly typed = output<string>();

  readonly id = `app-autocomplete-${nextId++}`;
  readonly state = signal<AutocompleteState>({ text: '', open: false, loading: false, options: [], active: -1, error: false });
  session!: AutocompleteSession;

  constructor() {
    let detach: (() => void) | undefined;
    effect(() => {
      const source = this.source();
      const delay = this.delay();
      untracked(() => {
        detach?.();
        this.session?.dispose();
        this.session = new AutocompleteSession(source, delay);
        this.session.setText(this.text());
        detach = this.session.subscribe((s) => this.state.set(s));
      });
    });
    effect(() => {
      const text = this.text();
      untracked(() => this.session?.setText(text));
    });
    inject(DestroyRef).onDestroy(() => {
      detach?.();
      this.session?.dispose();
    });
  }

  input(text: string): void {
    this.session.input(text);
    this.typed.emit(text);
  }

  key(e: KeyboardEvent): void {
    const out = this.session.key(e.key);
    if (out.handled) e.preventDefault();
    if (out.chosen) this.chosen.emit(out.chosen);
  }

  pick(index: number): void {
    const chosen = this.session.choose(index);
    if (chosen) this.chosen.emit(chosen);
  }
}
