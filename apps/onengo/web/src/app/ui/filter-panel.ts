import { Component, effect, input, output, signal, untracked, type OnDestroy } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { FormValues } from '../core/records/record/forms';
import { TranslatePipe } from '../services/i18n';
import { CfForm } from './cf-form';
import type { CfFieldDef } from './cf-types';
import { DialogFocus } from './dialog';
import { lockWhileOpen } from './form-panel';

@Component({
  selector: 'app-list-filter-sheet',
  imports: [CfForm, TranslatePipe, DialogFocus],
  styleUrl: './styles/app-list-filter-sheet.css',
  template: `
    @if (open()) {
      <div class="list-filter-sheet__backdrop" data-dialog-shade aria-hidden="true"></div>

      <div class="list-filter-sheet" appDialog role="dialog" [attr.aria-label]="title()" (escape)="closed.emit()">
        <div class="list-filter-sheet__handle" aria-hidden="true"></div>

        <div class="list-filter-sheet__title-row">
          <h2 class="list-filter-sheet__title">{{ title() }}</h2>
          <button type="button" class="list-filter-sheet__close" (click)="closed.emit()" [attr.aria-label]="'ui.common.close' | t">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="list-filter-sheet__body">
          <cf-form class="list-filter-sheet__form" [fields]="fields()" [values]="draft()" idPrefix="filter" (valuesChange)="draft.set($event)"></cf-form>
        </div>

        <div class="list-filter-sheet__actions app-btn-group">
          <button type="button" class="app-btn app-btn--ghost" (click)="onReset()">{{ 'ui.common.reset' | t }}</button>
          <button type="button" class="app-btn app-btn--primary" (click)="applied.emit(draft())">{{ 'ui.common.apply' | t }}</button>
        </div>
      </div>
    }
  `,
})
export class ListFilterSheet implements OnDestroy {
  readonly open = input(false);
  readonly title = input(t('ui.common.filters'));
  readonly fields = input.required<CfFieldDef[]>();
  readonly initialValues = input<FormValues>({});
  readonly closed = output<void>();
  readonly reset = output<void>();
  readonly applied = output<FormValues>();
  readonly draft = signal<FormValues>({});
  private readonly unlock = lockWhileOpen(() => this.open());

  constructor() {
    effect(() => {
      const open = this.open();
      const initial = this.initialValues();
      if (open) untracked(() => this.draft.set(structuredClone(initial)));
    });
  }

  onReset(): void {
    this.draft.set({});
    this.reset.emit();
  }

  ngOnDestroy(): void {
    this.unlock();
  }
}
