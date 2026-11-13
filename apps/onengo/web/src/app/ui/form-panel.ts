import { Component, computed, effect, inject, input, output, untracked, type OnDestroy } from '@angular/core';
import { t } from '../core/i18n/i18n';
import type { FormColumns } from '../core/models';
import type { FormValues } from '../core/records/record/forms';
import { Connectivity } from '../pwa/connectivity';
import { TranslatePipe } from '../services/i18n';
import { CfForm, CfFormStepper } from './cf-form';
import type { CfFieldDef } from './cf-types';
import { FormProblems } from '@onengo/web-kit';
import { DialogFocus, dialogCloseLabel } from './dialog';
import { setSheetOpen } from './panel-lock';

/** Tracks one sheet's open state for the page scroll lock. */
export function lockWhileOpen(open: () => boolean): () => void {
  let locked = false;
  effect(() => {
    const o = open();
    untracked(() => {
      if (o !== locked) setSheetOpen(o);
      locked = o;
    });
  });
  return () => locked && setSheetOpen(false);
}

@Component({
  selector: 'app-mobile-form-sheet',
  imports: [TranslatePipe, FormProblems, DialogFocus],
  styleUrl: './styles/app-mobile-form-sheet.css',
  template: `
    @if (open()) {
      <div class="mobile-form-sheet__backdrop" data-dialog-shade aria-hidden="true"></div>

      <div class="mobile-form-sheet" appDialog role="dialog" [attr.aria-label]="title()" (escape)="dismissed.emit()">
        <div class="mobile-form-sheet__handle" aria-hidden="true"></div>

        <div class="mobile-form-sheet__title-row">
          <h2 class="mobile-form-sheet__title">{{ title() }}</h2>
          <button type="button" class="mobile-form-sheet__close" (click)="dismissed.emit()" [attr.aria-label]="'ui.common.close' | t">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        @if (hint()) {
          <p class="mobile-form-sheet__hint">{{ hint() }}</p>
        }

        <app-form-problems [message]="error()" [problems]="problems()" />

        <div class="mobile-form-sheet__body">
          <ng-content></ng-content>
        </div>

        <div class="mobile-form-sheet__actions app-btn-group">
          <ng-content select="[sheetFooterActions]"></ng-content>
          @if (showDefaultFooter()) {
            <button type="button" class="app-btn app-btn--ghost" (click)="dismissed.emit()" [disabled]="saving()">
              {{ closeLabel() }}
            </button>
            <button type="button" class="app-btn app-btn--primary" (click)="save.emit()" [disabled]="saving() || !connectivity.online()">
              {{ saving() ? ('ui.common.saving' | t) : saveLabel() }}
            </button>
          }
        </div>
      </div>
    }
  `,
})
export class MobileFormSheet implements OnDestroy {
  readonly open = input(false);
  readonly title = input('');
  readonly hint = input<string | undefined>();
  /** What went wrong with the last save, shown inside the sheet; further problems follow it as a list. */
  readonly error = input('');
  readonly problems = input<string[]>([]);
  readonly saving = input(false);
  readonly saveLabel = input(t('ui.common.save'));
  readonly cancelLabel = input(t('ui.common.cancel'));
  readonly showDefaultFooter = input(true);
  readonly dismissed = output<void>();
  readonly save = output<void>();
  readonly closeLabel = computed(() => dialogCloseLabel(this.saveLabel(), this.cancelLabel()));
  readonly connectivity = inject(Connectivity);
  private readonly unlock = lockWhileOpen(() => this.open());

  ngOnDestroy(): void {
    this.unlock();
  }
}

/** A single-form sheet: create, or a workflow step that asks for fields. */
@Component({
  selector: 'app-list-create-sheet',
  imports: [MobileFormSheet, CfForm],
  styleUrl: './styles/app-list-create-sheet.css',
  template: `
    <app-mobile-form-sheet
      [open]="open()"
      [title]="title()"
      [hint]="hint()"
      [error]="error()"
      [problems]="problems()"
      [saving]="saving()"
      [saveLabel]="saveLabel()"
      (dismissed)="dismissed.emit()"
      (save)="saved.emit()">
      <ng-content select="[listCreatePrefix]"></ng-content>
      <cf-form [fields]="fields()" [values]="values()" [errors]="errors()" [idPrefix]="idPrefix()" [columns]="columns()" [fullWidth]="fullWidth()" (valuesChange)="valuesChange.emit($event)"></cf-form>
      <ng-content></ng-content>
    </app-mobile-form-sheet>
  `,
})
export class ListCreateSheet {
  readonly open = input(false);
  readonly title = input('');
  readonly hint = input<string | undefined>();
  readonly error = input('');
  readonly problems = input<string[]>([]);
  readonly saving = input(false);
  readonly saveLabel = input(t('ui.common.create'));
  readonly fields = input.required<CfFieldDef[]>();
  readonly values = input.required<FormValues>();
  readonly errors = input<Record<string, string>>({});
  readonly idPrefix = input('list-create');
  readonly columns = input<FormColumns>(1);
  readonly fullWidth = input<readonly string[]>([]);
  readonly dismissed = output<void>();
  readonly saved = output<void>();
  readonly valuesChange = output<FormValues>();
}

/** The create stepper: one step at a time, Back/Cancel and Next/Create in the footer. */
@Component({
  selector: 'app-list-create-stepper-sheet',
  imports: [MobileFormSheet, CfFormStepper, TranslatePipe],
  template: `
    <app-mobile-form-sheet [open]="open()" [title]="title()" [error]="error()" [problems]="problems()" [showDefaultFooter]="false" (dismissed)="dismissed.emit()">
      @if (open()) {
        <cf-form-stepper
          [stepLabel]="stepLabel()"
          [stepIndex]="stepIndex()"
          [stepCount]="stepCount()"
          [fields]="fields()"
          [values]="values()"
          [errors]="errors()"
          [idPrefix]="'list-create-' + stepIndex()"
          [columns]="columns()"
          [fullWidth]="fullWidth()"
          (valuesChange)="valuesChange.emit($event)">
        </cf-form-stepper>
      }

      @if (open()) {
        <button sheetFooterActions type="button" class="app-btn app-btn--ghost" [disabled]="saving()" (click)="back.emit()">
          {{ (stepIndex() === 0 ? 'ui.common.cancel' : 'ui.common.back') | t }}
        </button>
      }
      @if (open()) {
        <button sheetFooterActions type="button" class="app-btn app-btn--primary" [disabled]="saving() || (stepIndex() === stepCount() - 1 && !connectivity.online())" (click)="next.emit()">
          {{ stepIndex() === stepCount() - 1 ? (saving() ? ('ui.common.submitting' | t) : completeLabel()) : ('ui.common.next' | t) }}
        </button>
      }
    </app-mobile-form-sheet>
  `,
})
export class ListCreateStepperSheet {
  readonly open = input(false);
  readonly title = input('');
  readonly error = input('');
  readonly problems = input<string[]>([]);
  readonly saving = input(false);
  readonly completeLabel = input(t('ui.common.create'));
  readonly stepLabel = input('');
  readonly stepIndex = input(0);
  readonly stepCount = input(1);
  readonly fields = input.required<CfFieldDef[]>();
  readonly values = input.required<FormValues>();
  readonly errors = input<Record<string, string>>({});
  readonly columns = input<FormColumns>(1);
  readonly fullWidth = input<readonly string[]>([]);
  readonly dismissed = output<void>();
  readonly back = output<void>();
  readonly next = output<void>();
  readonly valuesChange = output<FormValues>();
  readonly connectivity = inject(Connectivity);
}
