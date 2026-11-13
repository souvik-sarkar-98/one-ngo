import { booleanAttribute, Component, computed, DestroyRef, effect, inject, input, output, signal, untracked, viewChild, type ElementRef } from '@angular/core';
import type { ExpressionAssist } from '../core/builder/expression-assist';
import { errorSpan, resultText, type ExpressionContext, type ValueType } from '../core/builder/expression-catalogue';
import { ExpressionSession, type ExpressionSettings, type ExpressionState } from '../core/builder/expression-session';
import { t } from '../core/i18n/i18n';
import { TranslatePipe } from '../services/i18n';
import { Autocomplete } from './autocomplete';
import { MobileFormSheet } from './form-panel';

let nextId = 0;

/** The text box of an expression with its suggestions and the live check's answer. */
@Component({
  selector: 'app-expression-box',
  imports: [TranslatePipe],
  styleUrl: './styles/expression-field.css',
  template: `
    @let s = state();
    <div class="expression-box" [class.expression-box--error]="s.checkState === 'error'" [class.expression-box--attached]="attached()">
      <div class="expression-box__row">
        @if (multiline()) {
          <textarea
            #box
            class="expression-box__input expression-box__input--multi"
            rows="3"
            role="combobox"
            aria-multiline="true"
            aria-autocomplete="list"
            spellcheck="false"
            autocomplete="off"
            [id]="inputId()"
            [placeholder]="placeholder()"
            [disabled]="disabled()"
            [attr.aria-label]="ariaLabel()"
            [attr.aria-expanded]="!!s.suggestions"
            [attr.aria-controls]="inputId() + '-list'"
            [attr.aria-activedescendant]="s.suggestions && s.active >= 0 ? inputId() + '-o' + s.active : null"
            [attr.aria-describedby]="inputId() + '-status'"
            (input)="typed($event)"
            (keydown)="keydown($event)"
            (keyup)="moved($event)"
            (click)="clicked($event)"
            (blur)="session().close()"></textarea>
        } @else {
          <input
            #box
            class="expression-box__input"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            spellcheck="false"
            autocomplete="off"
            [id]="inputId()"
            [placeholder]="placeholder()"
            [disabled]="disabled()"
            [attr.aria-label]="ariaLabel()"
            [attr.aria-expanded]="!!s.suggestions"
            [attr.aria-controls]="inputId() + '-list'"
            [attr.aria-activedescendant]="s.suggestions && s.active >= 0 ? inputId() + '-o' + s.active : null"
            [attr.aria-describedby]="inputId() + '-status'"
            (input)="typed($event)"
            (keydown)="keydown($event)"
            (keyup)="moved($event)"
            (click)="clicked($event)"
            (blur)="session().close()" />
        }
        <ng-content />
      </div>
      @if (s.suggestions; as list) {
        <ul class="expression-box__list" role="listbox" [id]="inputId() + '-list'">
          @for (e of list.items; track e.name; let i = $index) {
            <li
              class="expression-box__option"
              role="option"
              [id]="inputId() + '-o' + i"
              [class.expression-box__option--active]="i === s.active"
              [attr.aria-selected]="i === s.active"
              (mousedown)="$event.preventDefault()"
              (mouseenter)="session().highlight(i)"
              (click)="session().choose(i)">
              <code>{{ e.code }}</code>
              <span class="expression-box__note">{{ e.note ? (e.note.key | t: e.note.params) : e.label }}</span>
            </li>
          }
        </ul>
      }
      <div class="expression-box__status" role="status" [id]="inputId() + '-status'">
        @switch (s.checkState) {
          @case ('checking') {
            <span class="expression-box__muted">{{ 'ui.expression.checking' | t }}</span>
          }
          @case ('ok') {
            <span class="expression-box__ok">{{ 'ui.expression.valid' | t: { type: typeLabel(s.check?.resultType) } }}</span>
          }
          @case ('error') {
            <span class="expression-box__error">{{ s.check?.error }}</span>
            @if (s.check?.suggestion; as word) {
              <button type="button" class="expression-box__fix" (click)="session().fix()">{{ 'ui.expression.useSuggestion' | t: { word: word } }}</button>
            }
            @if (where(); as w) {
              <code class="expression-box__where">{{ w.before }}<mark>{{ w.at }}</mark>{{ w.after }}</code>
            }
          }
          @case ('failed') {
            <span class="expression-box__error">{{ 'ui.expression.checkFailed' | t }}</span>
          }
        }
      </div>
    </div>
  `,
})
export class ExpressionBox {
  readonly session = input.required<ExpressionSession>();
  readonly state = input.required<ExpressionState>();
  readonly inputId = input.required<string>();
  readonly multiline = input(false, { transform: booleanAttribute });
  /** A button is projected after the box and joins its border. */
  readonly attached = input(false, { transform: booleanAttribute });
  readonly placeholder = input('');
  readonly ariaLabel = input<string | null>(null);
  readonly disabled = input(false);
  private readonly box = viewChild<ElementRef<HTMLInputElement | HTMLTextAreaElement>>('box');

  readonly where = computed(() => {
    const s = this.state();
    return s.checkState === 'error' && s.check?.position !== undefined ? errorSpan(s.source, s.check.position) : null;
  });

  constructor() {
    let jump: number | null = null;
    effect(() => {
      const s = this.state();
      const el = this.box()?.nativeElement;
      if (!el) return;
      if (el.value !== s.source) el.value = s.source;
      if (jump !== null && s.jump !== jump) {
        el.focus();
        el.setSelectionRange(s.cursor, s.cursor);
      }
      jump = s.jump;
    });
  }

  typeLabel(type: ValueType | undefined): string {
    return t(`ui.expression.types.${type ?? 'unknown'}`);
  }

  typed(e: Event): void {
    const el = e.target as HTMLInputElement;
    this.session().input(el.value, el.selectionStart ?? el.value.length);
  }

  keydown(e: KeyboardEvent): void {
    if (this.session().key(e.key, e.ctrlKey || e.metaKey)) e.preventDefault();
  }

  moved(e: KeyboardEvent): void {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) this.clicked(e);
  }

  clicked(e: Event): void {
    const el = e.target as HTMLInputElement;
    this.session().caret(el.selectionStart ?? el.value.length);
  }
}

/**
 * An expression with help: suggestions while typing, the server's check as
 * you go (with "did you mean"), and a panel with the names and functions to
 * insert and "Try it" on a real record or sample values.
 */
@Component({
  selector: 'app-expression-field',
  imports: [TranslatePipe, ExpressionBox, MobileFormSheet, Autocomplete],
  styleUrl: './styles/expression-field.css',
  template: `
    @if (state(); as s) {
      <div class="expression-field">
        @if (label()) {
          <label class="expression-field__label" [attr.for]="id">{{ label() }}</label>
        }
        <app-expression-box attached [session]="session!" [state]="s" [inputId]="id" [placeholder]="placeholder()" [ariaLabel]="label() ? null : ariaLabel() || null" [disabled]="disabled()">
          <button type="button" class="expression-field__open" [attr.aria-label]="'ui.expression.open' | t" [title]="'ui.expression.open' | t" [disabled]="disabled()" (click)="openPanel()">ƒx</button>
        </app-expression-box>
        @if (hint()) {
          <div class="expression-field__hint">{{ hint() }}</div>
        }
      </div>
    }
    <app-mobile-form-sheet
      [open]="!!draftState()"
      [title]="panelTitle() || label() || ('ui.expression.title' | t)"
      [saveLabel]="'ui.expression.useThis' | t"
      (dismissed)="closePanel()"
      (save)="usePanel()">
      @if (draftState(); as d) {
        <app-expression-box multiline [session]="draft!" [state]="d" [inputId]="id + '-panel'" [ariaLabel]="'ui.expression.expression' | t" />
        <div class="expression-panel">
          <div>
            <h3 class="expression-panel__heading">{{ 'ui.expression.insertField' | t }}</h3>
            <div class="expression-panel__pills">
              @for (e of names(); track e.name) {
                <button type="button" class="expression-panel__pill" [title]="e.note ? (e.note.key | t: e.note.params) : (e.label ?? '')" (click)="draft!.insert(e)"><code>{{ e.name }}</code></button>
              }
            </div>
            <h3 class="expression-panel__heading">{{ 'ui.expression.functions' | t }}</h3>
            <ul class="expression-panel__functions">
              @for (e of functions(); track e.name) {
                <li>
                  <button type="button" class="expression-panel__pill" (click)="draft!.insert(e)"><code>{{ e.code }}</code></button>
                  <span class="expression-panel__note">{{ e.note!.key | t }}</span>
                </li>
              }
            </ul>
          </div>
          <div>
            <h3 class="expression-panel__heading">{{ 'ui.expression.tryIt' | t }}</h3>
            @if (d.subject.recordType) {
              <app-autocomplete
                [source]="draft!.recordSource"
                [label]="'ui.expression.sampleRecord' | t"
                [placeholder]="'ui.expression.sampleRecordPlaceholder' | t"
                [text]="d.record?.label ?? ''"
                (chosen)="draft!.pickRecord($event.id)" />
              <p class="expression-panel__note">{{ 'ui.expression.sampleHint' | t }}</p>
            }
            <div class="expression-panel__samples">
              @for (slot of d.slots; track slot.path) {
                <label class="expression-panel__sample">
                  <code>{{ slot.path }}</code>
                  @if (slot.input === 'boolean') {
                    <input type="checkbox" [checked]="d.sample[slot.path] === 'true'" (change)="draft!.setSample(slot.path, $any($event.target).checked ? 'true' : '')" />
                  } @else {
                    <input [type]="slot.input" [value]="d.sample[slot.path] || ''" [attr.aria-label]="slot.label ?? slot.path" (input)="draft!.setSample(slot.path, $any($event.target).value)" />
                  }
                </label>
              } @empty {
                <p class="expression-panel__note">{{ 'ui.expression.noValuesNeeded' | t }}</p>
              }
            </div>
            <button type="button" (click)="draft!.tryIt()" [disabled]="d.trying || !d.source.trim()">{{ (d.trying ? 'ui.expression.trying' : 'ui.expression.try') | t }}</button>
            @if (d.tried; as r) {
              <div class="expression-panel__result" role="status">
                @if (r.ok) {
                  {{ 'ui.expression.result' | t }} <code>{{ result(r.value) }}</code>
                } @else {
                  <span class="expression-box__error">{{ r.error }}</span>
                }
              </div>
            } @else if (d.tryFailed) {
              <div class="expression-panel__result expression-box__error" role="alert">{{ 'ui.expression.tryFailed' | t }}</div>
            }
          </div>
        </div>
      }
    </app-mobile-form-sheet>
  `,
})
export class ExpressionField {
  readonly value = input('');
  readonly assist = input.required<ExpressionAssist>();
  /** The record type the expression is about; its published fields and workflows are suggested and checked. */
  readonly recordType = input<string | null | undefined>(null);
  readonly context = input<ExpressionContext>('record');
  /** An action form's field keys, readable as `input.<key>`. */
  readonly formFields = input<readonly string[] | undefined>(undefined);
  readonly label = input('');
  /** Names the box when there is no visible label, e.g. in a table cell. */
  readonly ariaLabel = input('');
  readonly placeholder = input('');
  readonly hint = input('');
  readonly panelTitle = input('');
  readonly disabled = input(false);
  readonly valueChange = output<string>();

  readonly id = `app-expression-${nextId++}`;
  readonly state = signal<ExpressionState | null>(null);
  readonly draftState = signal<ExpressionState | null>(null);
  readonly names = computed(() => (this.draftState()?.catalogue ?? []).filter((e) => e.kind !== 'function' && e.kind !== 'previous'));
  readonly functions = computed(() => (this.draftState()?.catalogue ?? []).filter((e) => e.kind === 'function'));
  session: ExpressionSession | null = null;
  draft: ExpressionSession | null = null;
  private detachDraft: (() => void) | null = null;

  private readonly settings = computed<ExpressionSettings>(() => {
    const input = this.formFields();
    return { recordType: this.recordType() || null, context: this.context(), ...(input ? { input } : {}) };
  });

  constructor() {
    let detach: (() => void) | undefined;
    effect(() => {
      const assist = this.assist();
      untracked(() => {
        detach?.();
        this.session?.dispose();
        const session = new ExpressionSession(assist, this.settings(), this.value());
        this.session = session;
        detach = session.subscribe((s) => {
          this.state.set(s);
          if (s.source !== this.value()) this.valueChange.emit(s.source);
        });
      });
    });
    effect(() => {
      const settings = this.settings();
      untracked(() => {
        this.session?.configure(settings);
        this.draft?.configure(settings);
      });
    });
    effect(() => {
      const value = this.value();
      untracked(() => this.session?.setSource(value));
    });
    inject(DestroyRef).onDestroy(() => {
      detach?.();
      this.session?.dispose();
      this.closePanel();
    });
  }

  openPanel(): void {
    this.closePanel();
    const draft = new ExpressionSession(this.assist(), this.settings(), this.session?.snapshot.source ?? this.value());
    this.draft = draft;
    this.detachDraft = draft.subscribe((s) => this.draftState.set(s));
  }

  usePanel(): void {
    const source = this.draft?.snapshot.source;
    this.closePanel();
    if (source !== undefined) this.session?.setSource(source);
  }

  closePanel(): void {
    this.detachDraft?.();
    this.draft?.dispose();
    this.detachDraft = null;
    this.draft = null;
    this.draftState.set(null);
  }

  result(value: unknown): string {
    return resultText(value);
  }
}
