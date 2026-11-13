import { Component, computed, inject, input } from '@angular/core';
import { cronText } from '../../../core/builder/cron-text';
import { I18n } from '../../../services/i18n';

/** The schedule under its cron field, read out in plain words. */
@Component({
  selector: 'app-cron-preview',
  styleUrl: './preview.css',
  template: `
    @if (reading(); as r) {
      @if (r.ok) {
        <p class="pv__note" role="status">{{ r.text }}</p>
      } @else {
        <p class="pv__bad" role="alert">{{ r.error }}</p>
      }
    }
  `,
})
export class CronPreview {
  private readonly i18n = inject(I18n);
  readonly value = input<unknown>();
  readonly body = input<unknown>();
  readonly reading = computed(() => {
    this.i18n.locale();
    const v = this.value();
    return typeof v === 'string' && v.trim() ? cronText(v) : null;
  });
}
