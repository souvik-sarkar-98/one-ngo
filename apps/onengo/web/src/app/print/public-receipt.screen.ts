import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { t } from '../core/i18n/i18n';
import { browserTitle } from '../core/organisation/organisation';
import { publicReceiptPage, type PublicReceiptView, type ReceiptPage } from '../core/records/print/print';
import { TranslatePipe } from '../services/i18n';
import { Api, ApiError } from '../services/api';
import { canvasJpeg, drawReceipt, jpegPdf, pdfName, savePdf } from './receipt-pdf';

/** A receipt opened with its public token. No sign-in. The page is the same receipt as Print. */
@Component({
  selector: 'app-public-receipt-screen',
  imports: [TranslatePipe],
  styles: `
    :host { display: block; min-height: 100vh; background: #f1f5f9; color: #0f172a; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    .print__bar { display: flex; gap: 8px; justify-content: flex-end; max-width: 720px; margin: 0 auto; padding: 12px 16px; }
    .print__paper { box-sizing: border-box; max-width: 720px; margin: 0 auto 24px; padding: 22px 24px; background: #fff; border: 2px solid #0f172a; outline: 1px solid #0f172a; outline-offset: -6px; position: relative; overflow: hidden; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .print__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 12px; border-bottom: 1px solid #0f172a; }
    .print__issuer { display: flex; gap: 12px; align-items: flex-start; }
    .print__logo { width: 64px; height: 64px; object-fit: contain; }
    .print__org { font-size: 1.1em; font-weight: 700; }
    .print__regs { margin: 4px 0 0; padding: 0; list-style: none; font-size: 0.85em; }
    .print__number { text-align: end; font-weight: 700; }
    .print__muted { font-weight: 400; color: #475569; font-size: 0.9em; }
    .print__title { margin: 14px 0; padding-bottom: 12px; border-bottom: 1px solid #0f172a; font-size: 1.2em; text-align: center; letter-spacing: 0.04em; }
    .print__statement { margin: 0 0 14px; line-height: 1.5; }
    .print__thanks { margin: 16px 0 0; text-align: center; color: #334155; }
    .print__clause { margin: 14px 0 0; line-height: 1.5; }
    .print__rows { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 0; margin: 0; border: 1px solid #0f172a; }
    .print__rows dt, .print__rows dd { margin: 0; padding: 8px 10px; border-bottom: 1px solid #cbd5e1; }
    .print__rows dt { font-weight: 600; color: #334155; border-right: 1px solid #cbd5e1; background: #f8fafc; }
    .print__rows dd { word-break: break-word; }
    .print__rows dt:nth-last-of-type(1), .print__rows dd:last-of-type { border-bottom: 0; }
    .print__signature { display: block; margin-top: 28px; margin-inline-start: auto; max-width: 200px; max-height: 72px; }
    .print__sign { margin-top: 8px; margin-inline-start: auto; width: 200px; padding-top: 6px; border-top: 1px solid #0f172a; text-align: center; font-size: 0.9em; }
    .print__sign--alone { margin-top: 48px; }
    .print__sign-name { font-weight: 600; }
    .print__void { position: absolute; inset: 40% 0 auto; text-align: center; font-size: 2.4em; font-weight: 700; color: rgba(185, 28, 28, 0.25); transform: rotate(-12deg); }
    .print__state { max-width: 720px; margin: 24px auto; padding: 0 16px; }
    @page { margin: 14mm; }
    @media print {
      :host { background: #fff; }
      .print__bar { display: none; }
      .print__paper { border: 2px solid #000; outline: 1px solid #000; outline-offset: -6px; margin: 0 auto; max-width: none; padding: 18px 20px; }
      .print__rows dt { background: transparent; border-right-color: #000; }
      .print__rows, .print__head, .print__title, .print__sign { border-color: #000; }
    }
  `,
  template: `
    <div class="print__bar">
      <button type="button" class="app-btn app-btn--ghost" [disabled]="!page() || downloading()" (click)="download()">{{ 'ui.print.download' | t }}</button>
      <button type="button" class="app-btn app-btn--primary" [disabled]="!page()" (click)="print()">{{ 'ui.print.print' | t }}</button>
    </div>
    @if (page(); as p) {
      <article class="print__paper" [attr.aria-label]="p.title">
        <div class="print__head">
          <div class="print__issuer">
            @if (logo()) { <img class="print__logo" [src]="logo()" alt="" /> }
            <div>
              <div class="print__org">{{ p.issuer.name }}</div>
              @if (p.issuer.alsoKnownAs) { <div class="print__muted">{{ p.issuer.alsoKnownAs }}</div> }
              @for (line of p.issuer.addressLines; track $index) { <div class="print__muted">{{ line }}</div> }
              @if (p.issuer.contactLine) { <div class="print__muted">{{ p.issuer.contactLine }}</div> }
              @if (p.issuer.registrations.length) {
                <ul class="print__regs">
                  @for (r of p.issuer.registrations; track r) { <li>{{ r }}</li> }
                </ul>
              }
            </div>
          </div>
          <div class="print__number">{{ p.number }}<div class="print__muted">{{ p.date }}</div></div>
        </div>
        @if (p.issuer.note) { <p class="print__muted" role="note">{{ p.issuer.note }}</p> }
        <h1 class="print__title">{{ p.title }}</h1>
        @if (p.statement) { <p class="print__statement">{{ p.statement }}</p> }
        <dl class="print__rows">
          @for (row of p.rows; track row.label) { <dt>{{ row.label }}</dt><dd>{{ row.value }}</dd> }
        </dl>
        @for (clause of p.clauses; track $index) { <p class="print__clause">{{ clause }}</p> }
        <p class="print__thanks">{{ p.thanks }}</p>
        @if (signature()) { <img class="print__signature" [src]="signature()" alt="" /> }
        <div class="print__sign" [class.print__sign--alone]="!signature()">
          @if (p.signatory?.name) { <div class="print__sign-name">{{ p.signatory?.name }}</div> }
          @if (p.signatory?.designation) { <div class="print__muted">{{ p.signatory?.designation }}</div> }
          <div>{{ 'ui.print.signatory' | t }}</div>
        </div>
        @if (p.voided) { <div class="print__void" role="note">{{ p.voided }}</div> }
      </article>
    } @else if (loading()) {
      <p class="print__state" role="status">{{ 'ui.print.loading' | t }}</p>
    } @else if (error()) {
      <p class="print__state notice error" role="alert">{{ error() }}</p>
    }
  `,
})
export class PublicReceiptScreen {
  private readonly api = inject(Api);
  private readonly title = inject(Title);
  readonly token = input.required<string>();
  readonly page = signal<ReceiptPage | null>(null);
  readonly logo = signal<string | null>(null);
  readonly signature = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly downloading = signal(false);

  constructor() {
    effect(() => {
      const token = this.token();
      untracked(() => void this.load(token));
    });
  }

  print(): void {
    window.print();
  }

  async download(): Promise<void> {
    const page = this.page();
    if (!page || this.downloading()) return;
    this.downloading.set(true);
    try {
      const canvas = drawReceipt(page, await imageOf(this.logo()), await imageOf(this.signature()));
      savePdf(jpegPdf(await canvasJpeg(canvas), canvas.width, canvas.height), pdfName(page.number));
    } catch {
      this.error.set(t('ui.print.downloadFailed'));
    } finally {
      this.downloading.set(false);
    }
  }

  private async load(token: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.page.set(null);
    this.logo.set(null);
    this.signature.set(null);
    const base = `/api/public/receipts/${encodeURIComponent(token)}`;
    try {
      const view = await this.api.get<PublicReceiptView>(base);
      const page = publicReceiptPage(view);
      this.page.set(page);
      this.title.setTitle(browserTitle(page.number));
      if (view.hasLogo) this.logo.set(`${base}/logo`);
      if (view.hasSignature) this.signature.set(`${base}/signature`);
    } catch (e) {
      this.error.set(e instanceof ApiError ? t('ui.print.notFound') : t('ui.print.loadFailed'));
    } finally {
      this.loading.set(false);
    }
  }
}

function imageOf(src: string | null): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
