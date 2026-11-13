import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { t } from '../core/i18n/i18n';
import { TranslatePipe } from '../services/i18n';
import { canvasJpeg, drawReceipt, jpegPdf, pdfName, savePdf } from './receipt-pdf';
import { PrintStore } from './print-store';

/**
 * The receipt print view at /print/receipt/:id: a page laid out for paper.
 * Print opens the browser's print dialog. Download saves a PDF of the same
 * receipt in the browser. Only Back, Download and Print sit above it, and
 * they are hidden on paper. No app bar, navigation or breadcrumb.
 */
@Component({
  selector: 'app-receipt-print-screen',
  imports: [TranslatePipe],
  providers: [PrintStore],
  styles: `
    :host {
      display: block;
      min-height: 100vh;
      background: #f1f5f9;
      color: #0f172a;
      font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }
    .print__bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: space-between;
      max-width: 720px;
      margin: 0 auto;
      padding: 12px 16px;
    }
    .print__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .print__download-error {
      max-width: 720px;
      margin: 0 auto 12px;
      padding: 0 16px;
    }
    .print__paper {
      box-sizing: border-box;
      max-width: 720px;
      margin: 0 auto 24px;
      padding: 22px 24px;
      background: #fff;
      border: 2px solid #0f172a;
      outline: 1px solid #0f172a;
      outline-offset: -6px;
      position: relative;
      overflow: hidden;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    .print__head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid #0f172a;
    }
    .print__org {
      font-size: 1.1em;
      font-weight: 700;
    }
    .print__issuer {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      min-width: 0;
    }
    .print__logo {
      width: 64px;
      height: 64px;
      flex: 0 0 auto;
      object-fit: contain;
    }
    .print__regs {
      margin: 4px 0 0;
      padding: 0;
      list-style: none;
      font-size: 0.85em;
    }
    .print__note {
      margin: 12px 0 0;
    }
    .print__number {
      text-align: end;
      font-weight: 700;
    }
    .print__muted {
      font-weight: 400;
      color: #475569;
      font-size: 0.9em;
    }
    .print__title {
      margin: 14px 0;
      padding-bottom: 12px;
      border-bottom: 1px solid #0f172a;
      font-size: 1.2em;
      text-align: center;
      letter-spacing: 0.04em;
    }
    .print__statement {
      margin: 0 0 14px;
      line-height: 1.5;
    }
    .print__thanks {
      margin: 16px 0 0;
      text-align: center;
      color: #334155;
    }
    .print__clause {
      margin: 14px 0 0;
      line-height: 1.5;
    }
    .print__rows {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
      gap: 0;
      margin: 0;
      border: 1px solid #0f172a;
    }
    .print__rows dt,
    .print__rows dd {
      margin: 0;
      padding: 8px 10px;
      border-bottom: 1px solid #cbd5e1;
    }
    .print__rows dt {
      font-weight: 600;
      color: #334155;
      border-right: 1px solid #cbd5e1;
      background: #f8fafc;
    }
    .print__rows dd {
      word-break: break-word;
    }
    .print__rows dt:nth-last-of-type(1),
    .print__rows dd:last-of-type {
      border-bottom: 0;
    }
    .print__signature {
      display: block;
      margin-top: 28px;
      margin-inline-start: auto;
      max-width: 200px;
      max-height: 72px;
    }
    .print__sign {
      margin-top: 8px;
      margin-inline-start: auto;
      width: 200px;
      padding-top: 6px;
      border-top: 1px solid #0f172a;
      text-align: center;
      font-size: 0.9em;
    }
    .print__sign--alone {
      margin-top: 48px;
    }
    .print__sign-name {
      font-weight: 600;
    }
    .print__void {
      position: absolute;
      inset: 40% 0 auto;
      text-align: center;
      font-size: 2.4em;
      font-weight: 700;
      color: rgba(185, 28, 28, 0.25);
      transform: rotate(-12deg);
      pointer-events: none;
    }
    .print__state {
      max-width: 720px;
      margin: 24px auto;
      padding: 0 16px;
    }
    @media (max-width: 600px) {
      .print__paper {
        padding: 18px 16px;
      }
      .print__rows {
        grid-template-columns: minmax(0, 1fr);
      }
      .print__rows dt {
        border-right: 0;
        padding-bottom: 0;
      }
      .print__rows dd {
        padding-top: 2px;
      }
    }
    @page {
      margin: 14mm;
    }
    @media print {
      :host {
        background: #fff;
        min-height: 0;
      }
      .print__bar,
      .print__download-error {
        display: none;
      }
      .print__paper {
        border: 2px solid #000;
        outline: 1px solid #000;
        outline-offset: -6px;
        margin: 0 auto;
        max-width: none;
        padding: 18px 20px;
      }
      .print__rows {
        grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
      }
      .print__rows dt {
        border-right: 1px solid #000;
        padding-bottom: 8px;
        background: transparent;
      }
      .print__rows dd {
        padding-top: 8px;
      }
      .print__rows dt,
      .print__rows dd,
      .print__head,
      .print__title,
      .print__sign {
        border-color: #000;
      }
    }
  `,
  template: `
    <div class="print__bar">
      <button type="button" class="app-btn app-btn--ghost" (click)="store.back()">{{ 'ui.common.back' | t }}</button>
      <div class="print__actions">
        <button type="button" class="app-btn app-btn--ghost" [disabled]="!store.page() || downloading()" [attr.aria-busy]="downloading()" (click)="download()">
          {{ 'ui.print.download' | t }}
        </button>
        @if (store.canManageLink()) {
          <button type="button" class="app-btn app-btn--ghost" [disabled]="!store.page() || store.linkBusy()" (click)="copyLink()">{{ 'ui.print.copyLink' | t }}</button>
          <button type="button" class="app-btn app-btn--ghost" [disabled]="!store.link() || store.linkBusy()" (click)="revokeLink()">{{ 'ui.print.revokeLink' | t }}</button>
        }
        <button type="button" class="app-btn app-btn--primary" [disabled]="!store.page()" (click)="print()">{{ 'ui.print.print' | t }}</button>
      </div>
    </div>
    @if (notice()) {
      <p class="print__download-error notice" role="status">{{ notice() }}</p>
    }
    @if (downloadError()) {
      <p class="print__download-error notice error" role="alert">{{ downloadError() }}</p>
    }
    @if (store.page(); as p) {
      <article class="print__paper" [attr.aria-label]="p.title">
        <div class="print__head">
          <div class="print__issuer">
            @if (store.logo()) {
              <img class="print__logo" [src]="store.logo()" alt="" />
            }
            <div>
              <div class="print__org">{{ p.issuer.name }}</div>
              @if (p.issuer.alsoKnownAs) {
                <div class="print__muted">{{ p.issuer.alsoKnownAs }}</div>
              }
              @for (line of p.issuer.addressLines; track $index) {
                <div class="print__muted">{{ line }}</div>
              }
              @if (p.issuer.contactLine) {
                <div class="print__muted">{{ p.issuer.contactLine }}</div>
              }
              @if (p.issuer.registrations.length) {
                <ul class="print__regs" [attr.aria-label]="'ui.print.registrations' | t">
                  @for (r of p.issuer.registrations; track r) {
                    <li>{{ r }}</li>
                  }
                </ul>
              }
            </div>
          </div>
          <div class="print__number">
            {{ p.number }}
            <div class="print__muted">{{ p.date }}</div>
          </div>
        </div>
        @if (p.issuer.note) {
          <p class="print__muted print__note" role="note">{{ p.issuer.note }}</p>
        }
        <h1 class="print__title">{{ p.title }}</h1>
        @if (p.statement) {
          <p class="print__statement">{{ p.statement }}</p>
        }
        <dl class="print__rows">
          @for (row of p.rows; track row.label) {
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          }
        </dl>
        @for (clause of p.clauses; track $index) {
          <p class="print__clause">{{ clause }}</p>
        }
        <p class="print__thanks">{{ p.thanks }}</p>
        @if (store.signature()) {
          <img class="print__signature" [src]="store.signature()" alt="" />
        }
        <div class="print__sign" [class.print__sign--alone]="!store.signature()">
          @if (p.signatory?.name) {
            <div class="print__sign-name">{{ p.signatory?.name }}</div>
          }
          @if (p.signatory?.designation) {
            <div class="print__muted">{{ p.signatory?.designation }}</div>
          }
          <div>{{ 'ui.print.signatory' | t }}</div>
        </div>
        @if (p.voided) {
          <div class="print__void" role="note">{{ p.voided }}</div>
        }
      </article>
    } @else if (store.loading()) {
      <p class="print__state" role="status">{{ 'ui.print.loading' | t }}</p>
    } @else if (store.error()) {
      <p class="print__state notice error" role="alert">{{ store.error() }}</p>
    }
  `,
})
export class ReceiptPrintScreen {
  readonly store = inject(PrintStore);
  readonly id = input.required<string>();
  readonly downloading = signal(false);
  readonly downloadError = signal('');
  readonly notice = signal('');

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => {
        this.downloadError.set('');
        void this.store.load(id);
      });
    });
  }

  print(): void {
    window.print();
  }

  async copyLink(): Promise<void> {
    if (!this.store.page() || this.store.linkBusy()) return;
    this.downloadError.set('');
    try {
      const path = this.store.link() ?? (await this.store.createLink());
      await navigator.clipboard.writeText(`${location.origin}${path}`);
      this.downloadError.set('');
      this.notice.set(t('ui.print.linkCopied'));
    } catch {
      this.notice.set('');
      this.downloadError.set(t('ui.print.linkFailed'));
    }
  }

  async revokeLink(): Promise<void> {
    if (!this.store.link() || this.store.linkBusy()) return;
    this.notice.set('');
    try {
      await this.store.revokeLink();
    } catch {
      this.downloadError.set(t('ui.print.linkFailed'));
    }
  }

  /** Saves a PDF of this receipt. The file is made in the browser; nothing is sent away to be rendered. */
  async download(): Promise<void> {
    const page = this.store.page();
    if (!page || this.downloading()) return;
    this.downloading.set(true);
    this.downloadError.set('');
    try {
      const canvas = drawReceipt(page, await this.loadedImage(this.store.logo()), await this.loadedImage(this.store.signature()));
      savePdf(jpegPdf(await canvasJpeg(canvas), canvas.width, canvas.height), pdfName(page.number));
    } catch {
      this.downloadError.set(t('ui.print.downloadFailed'));
    } finally {
      this.downloading.set(false);
    }
  }

  private loadedImage(src: string | null): Promise<HTMLImageElement | null> {
    if (!src) return Promise.resolve(null);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }
}
