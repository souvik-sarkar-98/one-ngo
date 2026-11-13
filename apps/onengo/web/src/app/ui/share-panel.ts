import { Component, computed, input, output, viewChild } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { FormValues } from '../core/records/record/forms';
import type { Suggestion, SuggestionSource } from '../core/ui-logic/autocomplete';
import { TranslatePipe } from '../services/i18n';
import { Autocomplete } from './autocomplete';
import { CfForm } from './cf-form';
import type { CfFieldDef } from './cf-types';
import { MobileFormSheet } from './form-panel';

let nextId = 0;

/** One share as the panel draws it. */
export interface ShareRow {
  id: string;
  initials: string;
  name: string;
  line: string;
}

/**
 * The share panel: who the record is shared with (× removes at once), then a
 * person or role to add with "Can view" or "Can edit" and an optional last
 * day. The host owns every value.
 */
@Component({
  selector: 'app-share-panel',
  imports: [MobileFormSheet, Autocomplete, CfForm, TranslatePipe],
  styles: `
    .share-panel__note {
      margin: 0 0 12px;
      font-size: 0.8rem;
    }
    .share-panel__note--problem {
      color: #b91c1c;
    }
    .share-panel__note--done {
      color: #15803d;
    }
    .share-panel__note--warning {
      margin: -4px 0 12px;
      color: #b45309;
    }
    .share-panel__head {
      margin-bottom: 4px;
      font-size: 0.75rem;
      font-weight: 700;
      color: var(--secondary-700);
    }
    .share-panel__empty {
      margin: 4px 0 12px;
      font-size: 0.8rem;
      color: var(--secondary-500);
    }
    .share-panel__list {
      margin: 0 0 12px;
      padding: 0;
      list-style: none;
    }
    .share-panel__row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 2px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
    }
    .share-panel__avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      font-size: 0.7rem;
      font-weight: 700;
      background: var(--primary-100);
      color: var(--primary-700);
    }
    .share-panel__who {
      display: flex;
      flex: 1;
      min-width: 0;
      flex-direction: column;
      font-size: 0.8rem;
    }
    .share-panel__line {
      font-size: 0.72rem;
      color: var(--secondary-500);
    }
    .share-panel__remove {
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: #49454f;
      font: inherit;
      cursor: pointer;
    }
    .share-panel__remove:hover,
    .share-panel__remove:focus-visible {
      background: #eef3f8;
    }
    .share-panel__field {
      margin-bottom: 12px;
    }
    .share-panel__label {
      display: block;
      margin-bottom: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--secondary-700);
    }
    .share-panel__switch {
      display: inline-flex;
      border: 1px solid rgba(148, 163, 184, 0.5);
      border-radius: 999px;
      overflow: hidden;
    }
    .share-panel__switch button {
      padding: 6px 14px;
      border: 0;
      background: transparent;
      font: inherit;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .share-panel__switch button[aria-checked='true'] {
      background: var(--primary-100);
      color: var(--primary-700);
      font-weight: 600;
    }
  `,
  template: `
    <app-mobile-form-sheet [open]="true" [title]="title()" [saving]="busy()" [showDefaultFooter]="false" (dismissed)="dismissed.emit()">
      @if (error()) {
        <p class="share-panel__note share-panel__note--problem" role="alert">{{ error() }}</p>
      }
      @if (message()) {
        <p class="share-panel__note share-panel__note--done" role="status">{{ message() }}</p>
      }
      <div class="share-panel__head">{{ 'ui.share.count' | t: { count: shares().length } }}</div>
      @if (loading()) {
        <p class="share-panel__empty" role="status">{{ 'ui.share.loading' | t }}</p>
      } @else if (!shares().length) {
        <p class="share-panel__empty">{{ 'ui.share.none' | t }}</p>
      }
      <ul class="share-panel__list">
        @for (s of shares(); track s.id) {
          <li class="share-panel__row">
            <span class="share-panel__avatar" aria-hidden="true">{{ s.initials }}</span>
            <span class="share-panel__who">
              <b>{{ s.name }}</b>
              <span class="share-panel__line">{{ s.line }}</span>
            </span>
            <button type="button" class="share-panel__remove" [disabled]="busy()" [attr.aria-label]="'ui.share.remove' | t: { name: s.name }" (click)="remove.emit(s.id)">✕</button>
          </li>
        }
      </ul>

      <div class="share-panel__field" (focusout)="restore()">
        <app-autocomplete
          [source]="source()"
          [text]="chosenText()"
          [label]="'ui.share.add' | t"
          [placeholder]="'ui.share.addPlaceholder' | t"
          [delay]="250"
          [disabled]="busy()"
          (chosen)="chosen.emit($event)" />
        @if (errors()['principal']; as e) {
          <div class="cf-field-error" role="alert">{{ e }}</div>
        }
      </div>

      <div class="share-panel__field">
        <span class="share-panel__label" [id]="accessId">{{ 'ui.share.access' | t }}</span>
        <div class="share-panel__switch" role="radiogroup" [attr.aria-labelledby]="accessId">
          <button type="button" role="radio" [attr.aria-checked]="access() === 'read'" (click)="accessChange.emit('read')">{{ 'ui.share.canView' | t }}</button>
          <button type="button" role="radio" [attr.aria-checked]="access() === 'edit'" (click)="accessChange.emit('edit')">{{ 'ui.share.canEdit' | t }}</button>
        </div>
        @if (errors()['access']; as e) {
          <div class="cf-field-error" role="alert">{{ e }}</div>
        }
      </div>

      @if (warning()) {
        <p class="share-panel__note share-panel__note--warning" role="status">{{ warning() }}</p>
      }

      <cf-form [fields]="endFields()" [values]="endValues()" [errors]="endErrors()" idPrefix="share" (valuesChange)="setEnd($event)"></cf-form>

      <button sheetFooterActions type="button" class="app-btn app-btn--ghost" (click)="dismissed.emit()">{{ 'ui.common.close' | t }}</button>
      <button sheetFooterActions type="button" class="app-btn app-btn--primary" [disabled]="busy()" (click)="submit.emit()">
        {{ (busy() ? 'ui.common.submitting' : 'ui.share.submit') | t }}
      </button>
    </app-mobile-form-sheet>
  `,
})
export class SharePanel {
  readonly title = input.required<string>();
  readonly shares = input<ShareRow[]>([]);
  readonly loading = input(false);
  readonly busy = input(false);
  readonly source = input.required<SuggestionSource>();
  /** The chosen person's or role's name; '' when none is chosen. */
  readonly chosenText = input('');
  readonly access = input<'read' | 'edit'>('read');
  /** `YYYY-MM-DD`, or '' for no end. */
  readonly expiresOn = input('');
  /** Problems by part: `principal`, `access`, `expiresOn`. */
  readonly errors = input<Record<string, string>>({});
  readonly error = input('');
  readonly message = input('');
  /** What the share does not give the chosen person or role. */
  readonly warning = input('');
  readonly chosen = output<Suggestion>();
  readonly accessChange = output<'read' | 'edit'>();
  readonly expiresChange = output<string>();
  readonly submit = output<void>();
  readonly remove = output<string>();
  readonly dismissed = output<void>();

  private readonly box = viewChild.required(Autocomplete);
  readonly accessId = `app-share-access-${nextId++}`;
  readonly endFields = computed<CfFieldDef[]>(() => [
    { key: 'expiresOn', label: t('ui.share.endsOn'), type: 'date', required: false, readOnly: this.busy(), options: [], hint: t('ui.share.endsOnHint') },
  ]);
  readonly endValues = computed<FormValues>(() => ({ expiresOn: this.expiresOn() }));
  readonly endErrors = computed(() => {
    const out: Record<string, string> = {};
    const e = this.errors()['expiresOn'];
    if (e) out['expiresOn'] = e;
    return out;
  });

  /** Leaving the box without choosing shows the current choice again. */
  restore(): void {
    this.box().session.setText(this.chosenText());
  }

  setEnd(values: FormValues): void {
    const v = values['expiresOn'];
    this.expiresChange.emit(typeof v === 'string' ? v : '');
  }
}
