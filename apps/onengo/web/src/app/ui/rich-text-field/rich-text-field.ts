import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { t } from '../../core/i18n/i18n';
import type { FormValue } from '../../core/records/record/forms';
import { cleanRichText, safeLinkHref } from '../../core/fields/rich-text';
import { TranslatePipe } from '../../services/i18n';
import type { CfFieldDef } from '../cf-types';
import { RichTextView, placeRichText } from './rich-text-view';

/** The server's own limit on a rich-text value. */
const MAX_LENGTH = 50_000;

type Command = 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'insertOrderedList' | 'heading' | 'quote';

/** Text the person pastes from elsewhere, as paragraphs. */
function plainToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => `<p>${esc(p).replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * A small rich-text editor on contenteditable, with no library: bold, italic,
 * underline, bulleted and numbered lists, heading, quote and link. Everything
 * it holds, typed or pasted, is cleaned with the same allow-list the server
 * uses, and checked again node by node before it is put on screen.
 */
@Component({
  selector: 'app-rich-text-field',
  imports: [RichTextView, TranslatePipe],
  styles: `
    :host {
      display: block;
    }
    .rich-text-field {
      border: 1px solid #79747e;
      border-radius: 4px;
      overflow: hidden;
    }
    .rich-text-field[data-invalid='true'] {
      border-color: #ba1a1a;
    }
    .rich-text-field__bar {
      display: flex;
      flex-wrap: wrap;
      gap: 2px;
      padding: 4px;
      border-bottom: 1px solid #e2e8f0;
      background: #f8fafc;
    }
    .rich-text-field__bar button {
      min-width: 32px;
      height: 32px;
      border: 0;
      border-radius: 6px;
      background: none;
      font: inherit;
      font-size: 0.85rem;
      color: #334155;
      cursor: pointer;
    }
    .rich-text-field__bar button[aria-pressed='true'] {
      background: var(--primary-100, #e0e7ff);
      color: var(--primary-700, #3730a3);
    }
    .rich-text-field__editor {
      min-height: 140px;
      max-height: 50vh;
      overflow: auto;
      padding: 10px 12px;
      font-size: 0.875rem;
      line-height: 1.5;
      outline: none;
    }
    .rich-text-field__editor[contenteditable='false'] {
      background: #f8fafc;
    }
    .rich-text-field__link {
      display: flex;
      gap: 6px;
      padding: 6px;
      border-bottom: 1px solid #e2e8f0;
    }
    .rich-text-field__link input {
      flex: 1;
      min-width: 0;
      height: 34px;
      padding: 0 8px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font: inherit;
      font-size: 0.85rem;
    }
    .rich-text-field__problem {
      margin-top: 4px;
      font-size: 0.75rem;
      color: #b91c1c;
    }
  `,
  template: `
    @let f = field();
    <div class="rich-text-field" [attr.data-invalid]="invalid() || tooLong()">
      @if (!f.readOnly) {
        <div class="rich-text-field__bar" role="toolbar" [attr.aria-label]="f.label" (mousedown)="$event.preventDefault()">
          <button type="button" [attr.aria-pressed]="active().has('bold')" [attr.aria-label]="'ui.fields.richText.bold' | t" (click)="run('bold', editor)"><b>B</b></button>
          <button type="button" [attr.aria-pressed]="active().has('italic')" [attr.aria-label]="'ui.fields.richText.italic' | t" (click)="run('italic', editor)"><i>I</i></button>
          <button type="button" [attr.aria-pressed]="active().has('underline')" [attr.aria-label]="'ui.fields.richText.underline' | t" (click)="run('underline', editor)"><u>U</u></button>
          <button type="button" [attr.aria-pressed]="active().has('insertUnorderedList')" [attr.aria-label]="'ui.fields.richText.bullets' | t" (click)="run('insertUnorderedList', editor)">•≡</button>
          <button type="button" [attr.aria-pressed]="active().has('insertOrderedList')" [attr.aria-label]="'ui.fields.richText.numbers' | t" (click)="run('insertOrderedList', editor)">1≡</button>
          <button type="button" [attr.aria-pressed]="active().has('heading')" [attr.aria-label]="'ui.fields.richText.heading' | t" (click)="run('heading', editor)">H</button>
          <button type="button" [attr.aria-pressed]="active().has('quote')" [attr.aria-label]="'ui.fields.richText.quote' | t" (click)="run('quote', editor)">❝</button>
          <button type="button" [attr.aria-label]="'ui.fields.richText.link' | t" (click)="startLink(editor)">🔗</button>
        </div>
        @if (linking()) {
          <div class="rich-text-field__link">
            <input #linkInput type="url" [attr.aria-label]="'ui.fields.richText.link' | t" (keydown.enter)="$event.preventDefault(); addLink(linkInput.value, editor)" />
            <button type="button" class="app-btn app-btn--primary" (click)="addLink(linkInput.value, editor)">{{ 'ui.common.add' | t }}</button>
            <button type="button" class="app-btn app-btn--ghost" (click)="linking.set(false)">{{ 'ui.common.cancel' | t }}</button>
          </div>
        }
      }
      <div
        #editor
        class="rich-text-field__editor"
        role="textbox"
        aria-multiline="true"
        [id]="fieldId()"
        [attr.aria-labelledby]="fieldId() + '-label'"
        [attr.contenteditable]="f.readOnly ? 'false' : 'true'"
        [appRichText]="shown()"
        [richTextVersion]="version()"
        (input)="changed(editor)"
        (paste)="paste($event, editor)"
        (keyup)="track()"
        (mouseup)="track()"
        (focus)="track()"
        (blur)="tidy(editor)"></div>
    </div>
    @if (problem()) {
      <div class="rich-text-field__problem" role="alert">{{ problem() }}</div>
    } @else if (tooLong()) {
      <div class="rich-text-field__problem" role="alert">{{ 'ui.fields.richText.tooLong' | t: { max: max() } }}</div>
    }
  `,
})
export class RichTextField {
  readonly field = input.required<CfFieldDef>();
  readonly fieldId = input.required<string>();
  readonly value = input<FormValue>(null);
  readonly invalid = input(false);
  readonly valueChange = output<string>();

  readonly active = signal(new Set<string>());
  readonly linking = signal(false);
  readonly problem = signal('');
  readonly max = computed(() => Math.min(this.field().maxLength ?? MAX_LENGTH, MAX_LENGTH));
  private readonly html = computed(() => (typeof this.value() === 'string' ? (this.value() as string) : ''));
  readonly tooLong = computed(() => this.html().length > this.max());
  /** What the editor shows when the value changes from outside; `version` puts it back even when the text is the same. */
  readonly shown = signal('');
  readonly version = signal(0);
  /** What the editor last sent up, so its own changes coming back do not reset the caret. */
  private sent: string | null = null;
  private range: Range | null = null;

  constructor() {
    effect(() => {
      const html = this.html();
      untracked(() => {
        if (html === this.sent) return;
        this.sent = html;
        this.shown.set(html);
        this.version.update((v) => v + 1);
      });
    });
  }

  run(command: Command, editor: HTMLElement): void {
    this.problem.set('');
    this.focus(editor);
    if (command === 'heading' || command === 'quote') {
      const tag = command === 'heading' ? 'h4' : 'blockquote';
      document.execCommand('formatBlock', false, this.active().has(command) ? 'p' : tag);
    } else document.execCommand(command);
    this.changed(editor);
  }

  startLink(editor: HTMLElement): void {
    const sel = document.getSelection();
    const inside = sel?.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer);
    this.range = inside ? sel!.getRangeAt(0).cloneRange() : null;
    this.problem.set('');
    this.linking.set(true);
  }

  addLink(address: string, editor: HTMLElement): void {
    const href = safeLinkHref(address);
    if (!href) {
      this.problem.set(address.trim() ? t('ui.fields.richText.linkInvalid') : '');
      return;
    }
    this.linking.set(false);
    this.focus(editor);
    if (this.range) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(this.range);
    }
    if (this.range && !this.range.collapsed) document.execCommand('createLink', false, href);
    else document.execCommand('insertHTML', false, `<a href="${href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">${href.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</a>`);
    this.range = null;
    this.changed(editor);
  }

  paste(e: ClipboardEvent, editor: HTMLElement): void {
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    const html = data.getData('text/html');
    const clean = cleanRichText(html || plainToHtml(data.getData('text/plain')));
    if (clean) document.execCommand('insertHTML', false, clean);
    this.changed(editor);
  }

  changed(editor: HTMLElement): void {
    const clean = cleanRichText(editor.innerHTML);
    this.sent = clean;
    this.valueChange.emit(clean);
    this.track();
  }

  /** On leaving the editor, shows exactly what will be saved. */
  tidy(editor: HTMLElement): void {
    if (this.linking()) return;
    const clean = cleanRichText(editor.innerHTML);
    if (editor.innerHTML !== clean) placeRichText(editor, clean);
  }

  track(): void {
    if (this.field().readOnly) return;
    const on = new Set<string>();
    for (const c of ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList']) if (document.queryCommandState(c)) on.add(c);
    const block = String(document.queryCommandValue('formatBlock')).toLowerCase();
    if (block === 'h4' || block === 'h3') on.add('heading');
    if (block === 'blockquote') on.add('quote');
    this.active.set(on);
  }

  private focus(editor: HTMLElement): void {
    if (document.activeElement !== editor) editor.focus();
    document.execCommand('defaultParagraphSeparator', false, 'p');
  }
}
