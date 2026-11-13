import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { TranslatePipe } from '../services/i18n';
import { ReportPrintStore } from './report-print-store';

/**
 * The report print page at /print/report/:key, laid out like a receipt: no
 * app bar, navigation or breadcrumb. With parameters it is a preview that
 * keeps nothing, and Publish sits where Print sits on a receipt. With
 * `?published=` it is a file already kept, and Download replaces Publish.
 */
@Component({
  selector: 'app-report-print-screen',
  imports: [TranslatePipe],
  providers: [ReportPrintStore],
  styles: `
    :host { display: block; min-height: 100vh; background: #f1f5f9; color: #0f172a; }
    .print__bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; max-width: 210mm; margin: 0 auto; padding: 12px 16px; }
    .print__spacer { flex: 1; }
    .print__state-label { color: #475569; font-size: 0.9em; }
    .print__frame { display: block; width: min(210mm, 100%); min-height: 297mm; margin: 0 auto 24px; border: 0; background: #fff; box-shadow: 0 8px 28px rgba(15, 23, 42, .12); }
    .print__state { max-width: 210mm; margin: 0 auto; padding: 0 16px 12px; }
    @media print {
      .print__bar, .print__state { display: none; }
      :host { background: #fff; }
    }
  `,
  template: `
    <div class="print__bar">
      <button type="button" class="app-btn app-btn--ghost" (click)="store.back()">{{ 'ui.common.back' | t }}</button>
      <span class="print__spacer"></span>
      @if (store.publishedId()) {
        <button type="button" class="app-btn app-btn--primary" [disabled]="!store.html() || store.busy()" (click)="download()">{{ 'ui.reports.downloadFile' | t }}</button>
      } @else {
        <span class="print__state-label">{{ 'ui.reports.notPublished' | t }}</span>
        <button type="button" class="app-btn app-btn--primary" [disabled]="!store.html() || store.busy()" [attr.aria-busy]="store.busy()" (click)="store.publish()">
          {{ (store.busy() ? 'ui.reports.publishing' : 'ui.reports.publish') | t }}
        </button>
      }
    </div>
    @if (store.error()) {
      <p class="print__state notice error" role="alert">{{ store.error() }}</p>
    }
    @if (store.loading()) {
      <p class="print__state" role="status">{{ 'ui.common.loading' | t }}</p>
    } @else if (store.html()) {
      <iframe class="print__frame" sandbox="" referrerpolicy="no-referrer" [attr.title]="'ui.nav.reports' | t" [srcdoc]="doc()"></iframe>
    }
  `,
})
export class ReportPrintScreen {
  readonly store = inject(ReportPrintStore);
  private readonly sanitizer = inject(DomSanitizer);
  readonly key = input.required<string>();
  readonly doc = computed<SafeHtml>(() => this.sanitizer.bypassSecurityTrustHtml(this.store.html()));

  constructor() {
    effect(() => {
      const key = this.key();
      untracked(() => void this.store.load(key));
    });
    effect(() => {
      if (this.store.printOnLoad() && !this.store.loading()) setTimeout(() => window.print(), 300);
    });
  }

  /** A PDF is the kept page, saved as PDF from the print dialog; Excel downloads the kept workbook. */
  download(): void {
    if (this.store.format() === 'pdf') window.print();
    else void this.store.downloadWorkbook();
  }
}
