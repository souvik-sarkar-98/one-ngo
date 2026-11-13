import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import type { TemplatePreview as Filled } from '../../../core/builder/http-previews';
import type { GatewayError } from '../../../core/records/gateway/gateway';
import { TranslatePipe } from '../../../services/i18n';
import { GenericEditorStore } from './generic-store';
import { PreviewRecord, type ChosenRecord } from './preview-record';
import { PreviewStore } from './preview-store';

type Body = Record<string, unknown>;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const frame = (body: string, pre: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
  `<style>body{margin:0;padding:.6rem .7rem;font:14px/1.5 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d2733;${pre ? 'white-space:pre-wrap;' : ''}overflow-wrap:anywhere}</style></head>` +
  `<body>${body}</body></html>`;

/** The message as a document of its own: text only, nothing loaded, no scripts (the frame is sandboxed). */
const messageDocument = (text: string) => frame(escapeHtml(text), true);

/** Email HTML already sanitised by the server, still shown in a frame that loads nothing and runs nothing. */
const htmlDocument = (html: string) => frame(html, false);

/** Placeholder chips and a filled preview of every channel, plus "Send a test to me". */
@Component({
  selector: 'app-template-preview',
  imports: [TranslatePipe, PreviewRecord],
  styleUrl: './preview.css',
  template: `
    <section class="pv" aria-labelledby="tpl-preview-title">
      <h3 class="pv__title" id="tpl-preview-title">{{ 'ui.builder.preview.title' | t }}</h3>
      <app-preview-record (changed)="choose($event)" />
      @if (placeholders().length) {
        <div class="help">{{ 'ui.builder.preview.insert' | t }}</div>
        <div class="pv__chips">
          @for (p of placeholders(); track p) {
            <button type="button" class="pv__chip" [attr.aria-label]="('ui.builder.preview.insertOne' | t: { name: p })" (click)="insert(p)">{{ braces(p) }}</button>
          }
        </div>
      }
      @if (!chosen()?.recordId) { <p class="pv__note">{{ 'ui.builder.preview.noRecord' | t }}</p> }
      @if (error(); as e) {
        <div class="pv__bad" role="alert">
          {{ e.message }}
          @if (e.issues?.length) { <ul class="pv__list">@for (i of e.issues; track $index) { <li>{{ i.message }}</li> }</ul> }
        </div>
      } @else if (document()) {
        <iframe class="pv__frame pv__sheet" sandbox="" referrerpolicy="no-referrer" [attr.title]="'ui.builder.preview.document' | t" [srcdoc]="emailDoc()"></iframe>
      } @else if (filled(); as f) {
        <div class="pv__channel">
          <h4 class="pv__channel-title">{{ 'ui.builder.preview.email' | t }}</h4>
          <div class="pv__mail">
            <div class="pv__subject">{{ f.subject }}</div>
            <iframe class="pv__frame" sandbox="" referrerpolicy="no-referrer" [attr.title]="'ui.builder.preview.email' | t" [srcdoc]="emailDoc()"></iframe>
          </div>
        </div>
        <div class="pv__channel">
          <h4 class="pv__channel-title">{{ 'ui.builder.preview.notification' | t }}</h4>
          <div class="pv__mail">
            <div class="pv__subject">{{ f.subject }}</div>
            <iframe class="pv__frame" sandbox="" referrerpolicy="no-referrer" [attr.title]="'ui.builder.preview.notification' | t" [srcdoc]="noticeDoc()"></iframe>
          </div>
        </div>
        <div class="pv__channel">
          <h4 class="pv__channel-title">{{ 'ui.builder.preview.sms' | t }}</h4>
          <div class="pv__sms">{{ f.body }}</div>
        </div>
        <div class="pv__channel">
          <h4 class="pv__channel-title">{{ 'ui.builder.preview.whatsapp' | t }}</h4>
          @if (f.whatsapp; as w) {
            <div class="pv__subject">{{ w.name }}</div>
            <p class="pv__note">{{ w.language }}</p>
            @if (w.parameters.length) { <ol class="pv__params">@for (p of w.parameters; track $index) { <li>{{ p }}</li> }</ol> }
          } @else {
            <div class="pv__sms">{{ f.body }}</div>
          }
        </div>
      }
      @if (!document()) {
      <div class="pv__row">
        <button type="button" class="small" [disabled]="sending()" (click)="sendTest()">{{ 'ui.builder.preview.sendTest' | t }}</button>
        @if (sent(); as s) { <span class="pv__ok" role="status">{{ 'ui.builder.preview.sentTo' | t: { email: s } }}</span> }
        @if (sendError(); as e) { <span class="pv__bad" role="alert">{{ e }}</span> }
      </div>
      }
    </section>
  `,
})
export class TemplatePreview {
  private readonly previews = inject(PreviewStore);
  private readonly editor = inject(GenericEditorStore);
  private readonly sanitizer = inject(DomSanitizer);
  readonly value = input<unknown>();
  readonly body = input<Body | null>(null);
  readonly chosen = signal<ChosenRecord | null>(null);
  readonly fields = signal<string[]>([]);
  readonly filled = signal<Filled | null>(null);
  readonly error = signal<GatewayError | null>(null);
  readonly sending = signal(false);
  readonly sent = signal('');
  readonly sendError = signal('');
  readonly placeholders = computed(() => (this.chosen() ? ['record.number', ...this.fields().map((f) => `record.${f}`)] : []));
  readonly document = computed(() => this.body()?.['kind'] === 'document');
  readonly emailDoc = computed<SafeHtml>(() => {
    const f = this.filled();
    return this.sanitizer.bypassSecurityTrustHtml(f?.html ? htmlDocument(f.html) : messageDocument(f?.body ?? ''));
  });
  readonly noticeDoc = computed<SafeHtml>(() => this.sanitizer.bypassSecurityTrustHtml(messageDocument(this.filled()?.body ?? '')));
  private readonly source = computed(() => {
    const b = this.body();
    const wa = b?.['whatsapp'];
    const whatsapp = wa && typeof wa === 'object' && !Array.isArray(wa) ? (wa as Record<string, unknown>) : undefined;
    return {
      subject: typeof b?.['subject'] === 'string' ? b['subject'] : '',
      body: typeof b?.['body'] === 'string' ? b['body'] : '',
      ...(typeof b?.['html'] === 'string' && b['html'].trim() ? { html: b['html'] } : {}),
      ...(b?.['kind'] === 'document' ? { kind: 'document' as const } : {}),
      ...(whatsapp && typeof whatsapp['name'] === 'string' && whatsapp['name'] ? { whatsapp } : {}),
    };
  });
  private run = 0;

  constructor() {
    effect((onCleanup) => {
      const request = { ...this.source(), ...this.chosen() };
      const timer = setTimeout(() => untracked(() => void this.fill(request)), 400);
      onCleanup(() => clearTimeout(timer));
    });
  }

  braces(p: string): string {
    return `{{ ${p} }}`;
  }

  async choose(c: ChosenRecord | null): Promise<void> {
    this.chosen.set(c);
    this.sent.set('');
    this.fields.set(c ? (await this.previews.fields(c.recordType).catch(() => [])).map((f) => f.key) : []);
  }

  insert(p: string): void {
    const path = this.editor.messageFocus();
    const key = String(path.at(-1) ?? 'body');
    const raw = this.body()?.[key];
    const current = typeof raw === 'string' ? raw : '';
    this.editor.set(path, `${current}${current && !/\s$/.test(current) ? ' ' : ''}${this.braces(p)}`);
  }

  private async fill(request: { subject: string; body: string; html?: string; kind?: 'document'; whatsapp?: unknown; recordType?: string; recordId?: string }): Promise<void> {
    if (!request.subject && !request.body && !request.html && !request.whatsapp) return;
    const run = ++this.run;
    const { recordType, recordId, ...template } = request;
    const r = await this.previews.previewTemplate({ ...template, ...(recordId ? { recordType, recordId } : {}) });
    if (run !== this.run) return;
    this.filled.set(r.ok ? r.value : null);
    this.error.set(r.ok ? null : r.error);
  }

  async sendTest(): Promise<void> {
    const c = this.chosen();
    this.sending.set(true);
    this.sent.set('');
    this.sendError.set('');
    const r = await this.previews.testTemplate({ ...this.source(), ...(c?.recordId ? { recordType: c.recordType, recordId: c.recordId } : {}) });
    this.sending.set(false);
    if (r.ok) this.sent.set(r.value.sentTo);
    else this.sendError.set(r.error.message);
  }
}
