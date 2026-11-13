import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import type { Suggestion } from '../../../core/ui-logic/autocomplete';
import { TranslatePipe } from '../../../services/i18n';
import { Autocomplete } from '../../../ui/autocomplete';
import { PreviewStore } from './preview-store';

export interface ChosenRecord {
  recordType: string;
  recordId?: string;
  label?: string;
}

/** The record a preview is filled from: a record type (unless the definition names one) and one of its records. */
@Component({
  selector: 'app-preview-record',
  imports: [Autocomplete, TranslatePipe],
  styleUrl: './preview.css',
  template: `
    @if (!fixedType()) {
      <app-autocomplete [label]="'ui.builder.preview.recordType' | t" [text]="typeLabel()" [source]="store.recordTypeSource" (chosen)="chooseType($event)" />
    }
    @if (recordType(); as rt) {
      @for (k of [rt]; track k) {
        <app-autocomplete
          [label]="'ui.builder.preview.record' | t"
          [text]="recordLabel()"
          [source]="store.recordSource(k)"
          [placeholder]="'ui.builder.preview.recordHint' | t"
          (typed)="typed($event)"
          (chosen)="chooseRecord($event)" />
      }
    }
  `,
})
export class PreviewRecord {
  readonly store = inject(PreviewStore);
  /** The record type the definition is for; when empty, a record type is chosen here. */
  readonly fixedType = input('');
  readonly changed = output<ChosenRecord | null>();
  private readonly chosenType = signal<Suggestion | null>(null);
  readonly typeLabel = computed(() => this.chosenType()?.label ?? '');
  readonly recordType = computed(() => this.fixedType() || this.chosenType()?.id || '');
  readonly recordLabel = signal('');
  private recordId = '';

  constructor() {
    effect(() => {
      const rt = this.recordType();
      untracked(() => {
        this.recordId = '';
        this.recordLabel.set('');
        this.changed.emit(rt ? { recordType: rt } : null);
      });
    });
  }

  chooseType(s: Suggestion): void {
    this.chosenType.set(s);
  }

  chooseRecord(s: Suggestion): void {
    this.recordId = s.id;
    this.recordLabel.set(s.label);
    this.changed.emit({ recordType: this.recordType(), recordId: s.id, label: s.label });
  }

  typed(text: string): void {
    if (text.trim() || !this.recordId) return;
    this.recordId = '';
    this.changed.emit({ recordType: this.recordType() });
  }
}
