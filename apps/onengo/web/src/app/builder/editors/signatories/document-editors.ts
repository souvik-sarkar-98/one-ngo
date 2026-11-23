import { Component, computed, inject } from '@angular/core';
import { BuilderStore } from '../../builder-store';
import { GenericEditor } from '../generic/generic-editor';
import { SignatoriesPanel } from './signatories-panel';

/** A report's Visual tab: its generated settings, then the signatories it prints. */
@Component({
  selector: 'app-report-editor',
  imports: [GenericEditor, SignatoriesPanel],
  template: `
    <app-generic-editor />
    @if (documentKey(); as key) {
      <app-signatories-panel [documentKey]="key" />
    }
  `,
})
export class ReportEditor {
  private readonly builder = inject(BuilderStore);
  readonly documentKey = computed(() => {
    const key = this.builder.state()?.key;
    return key ? `report:${key}` : '';
  });
}

/** A receipt rule's Visual tab: its generated settings, then the signatories its receipts print. */
@Component({
  selector: 'app-receipt-rule-editor',
  imports: [GenericEditor, SignatoriesPanel],
  template: `
    <app-generic-editor />
    @if (documentKey(); as key) {
      <app-signatories-panel [documentKey]="key" [receipts]="true" />
    }
  `,
})
export class ReceiptRuleEditor {
  private readonly builder = inject(BuilderStore);
  readonly documentKey = computed(() => {
    const key = this.builder.state()?.key;
    return key ? `receipt:${key}` : '';
  });
}
