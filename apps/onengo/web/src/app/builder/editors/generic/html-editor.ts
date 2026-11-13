import { Component, ElementRef, effect, input, output, signal, viewChild } from '@angular/core';
import { sanitiseEmailHtml } from '@onengo/platform/browser';
import { TranslatePipe } from '../../../services/i18n';

const LINK = /^(https?:|mailto:)/i;
const IMAGE = /^https:\/\//i;
const EMPTY = /^(?:<br>|\s)*$/i;
const TABLE = '<table><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></table>';

/** Visual email editor. Design edits the layout; HTML keeps the source, including pasted tables. */
@Component({
  selector: 'app-html-editor',
  imports: [TranslatePipe],
  styleUrl: './html-editor.css',
  template: `
    <div class="field">
      <div class="html-ed__head">
        <span class="gen-label" [id]="fieldId() + '-label'">{{ label() }}</span>
        <div class="html-ed__modes" role="group" [attr.aria-label]="'ui.builder.html.toolbar' | t">
          <button type="button" [attr.aria-pressed]="mode() === 'design'" (click)="mode.set('design')">{{ 'ui.builder.html.design' | t }}</button>
          <button type="button" [attr.aria-pressed]="mode() === 'html'" (click)="mode.set('html')">{{ 'ui.builder.html.source' | t }}</button>
        </div>
      </div>
      <div class="html-ed__bar" role="toolbar" [attr.aria-label]="'ui.builder.html.toolbar' | t">
        <button type="button" [disabled]="mode() !== 'design'" (mousedown)="keep($event)" (click)="block('p')">{{ 'ui.builder.html.paragraph' | t }}</button>
        <button type="button" [disabled]="mode() !== 'design'" (mousedown)="keep($event)" (click)="block('h2')">{{ 'ui.builder.html.heading' | t }}</button>
        <button type="button" [disabled]="mode() !== 'design'" [attr.aria-pressed]="bold()" (mousedown)="keep($event)" (click)="run('bold')">{{ 'ui.builder.html.bold' | t }}</button>
        <button type="button" [disabled]="mode() !== 'design'" [attr.aria-pressed]="italic()" (mousedown)="keep($event)" (click)="run('italic')">{{ 'ui.builder.html.italic' | t }}</button>
        <button type="button" [disabled]="mode() !== 'design'" [attr.aria-pressed]="underline()" (mousedown)="keep($event)" (click)="run('underline')">{{ 'ui.builder.html.underline' | t }}</button>
        <button type="button" [disabled]="mode() !== 'design'" (mousedown)="keep($event)" (click)="run('insertUnorderedList')">{{ 'ui.builder.html.bullets' | t }}</button>
        <button type="button" [disabled]="mode() !== 'design'" (mousedown)="keep($event)" (click)="run('insertOrderedList')">{{ 'ui.builder.html.numbers' | t }}</button>
        <button type="button" [disabled]="mode() !== 'design'" (mousedown)="keep($event)" (click)="askFor('link')">{{ 'ui.builder.html.link' | t }}</button>
        <button type="button" [disabled]="mode() !== 'design'" (mousedown)="keep($event)" (click)="askFor('image')">{{ 'ui.builder.html.image' | t }}</button>
        <button type="button" [disabled]="mode() !== 'design'" (mousedown)="keep($event)" (click)="insertTable()">{{ 'ui.builder.html.table' | t }}</button>
      </div>
      @if (ask(); as kind) {
        <div class="html-ed__ask">
          <label [for]="fieldId() + '-url'">{{ (kind === 'link' ? 'ui.builder.html.linkUrl' : 'ui.builder.html.imageUrl') | t }}</label>
          <input [id]="fieldId() + '-url'" [value]="url()" spellcheck="false" (input)="url.set($any($event.target).value)" (keydown.enter)="applyAsk($event)" />
          <button type="button" (click)="applyAsk()">{{ 'ui.builder.html.apply' | t }}</button>
          @if (urlError(); as key) { <div class="error" role="alert">{{ key | t }}</div> }
        </div>
      }
      @if (mode() === 'design') {
        <div
          #surface
          class="html-ed__design"
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          [attr.aria-labelledby]="fieldId() + '-label'"
          (focus)="focused.emit()"
          (paste)="onPaste($event)"
          (blur)="commitDesign()"
          (input)="onDesignInput()"></div>
      } @else {
        <textarea
          class="html-ed__source"
          spellcheck="false"
          [id]="fieldId()"
          [value]="value()"
          [attr.aria-labelledby]="fieldId() + '-label'"
          (focus)="focused.emit()"
          (keydown)="sourceKey($event)"
          (input)="onSource($any($event.target).value)"></textarea>
      }
      @if (hint()) { <div class="help">{{ hint() }}</div> }
    </div>
  `,
})
export class HtmlEditor {
  readonly fieldId = input.required<string>();
  readonly label = input.required<string>();
  readonly hint = input('');
  readonly value = input('');
  readonly valueChange = output<string>();
  readonly focused = output<void>();
  readonly mode = signal<'design' | 'html'>('design');
  readonly ask = signal<'link' | 'image' | null>(null);
  readonly url = signal('');
  readonly urlError = signal('');
  readonly bold = signal(false);
  readonly italic = signal(false);
  readonly underline = signal(false);
  private readonly surface = viewChild<ElementRef<HTMLDivElement>>('surface');
  private local = '';
  private painted: HTMLElement | null = null;
  private range: Range | null = null;
  private tabLeaves = false;

  constructor() {
    effect(() => {
      const el = this.surface()?.nativeElement;
      const next = this.value();
      if (!el) return;
      if (el === this.painted && next === this.local) return;
      el.innerHTML = sanitiseEmailHtml(next);
      this.local = next;
      this.painted = el;
    });
    document.addEventListener('selectionchange', this.marks);
  }

  ngOnDestroy(): void {
    document.removeEventListener('selectionchange', this.marks);
  }

  keep(event: Event): void {
    event.preventDefault();
    this.remember();
  }

  askFor(kind: 'link' | 'image'): void {
    this.remember();
    this.url.set('');
    this.urlError.set('');
    this.ask.set(this.ask() === kind ? null : kind);
  }

  block(tag: 'p' | 'h2'): void {
    this.restore();
    document.execCommand('formatBlock', false, `<${tag}>`);
    this.onDesignInput();
  }

  run(command: string): void {
    this.restore();
    document.execCommand(command, false);
    this.onDesignInput();
  }

  insert(html: string): void {
    this.restore();
    document.execCommand('insertHTML', false, html);
    this.onDesignInput();
  }

  insertTable(): void {
    this.insert(TABLE);
  }

  applyAsk(event?: Event): void {
    event?.preventDefault();
    const kind = this.ask();
    const address = this.url().trim();
    if (kind === 'link' && !LINK.test(address)) {
      this.urlError.set('ui.builder.html.badLink');
      return;
    }
    if (kind === 'image' && !IMAGE.test(address)) {
      this.urlError.set('ui.builder.html.badImage');
      return;
    }
    this.urlError.set('');
    this.restore();
    if (kind === 'link') document.execCommand('createLink', false, address);
    if (kind === 'image') document.execCommand('insertImage', false, address);
    this.ask.set(null);
    this.onDesignInput();
  }

  onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const html = event.clipboardData?.getData('text/html') ?? '';
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (html) document.execCommand('insertHTML', false, sanitiseEmailHtml(html));
    else document.execCommand('insertText', false, text);
    this.onDesignInput();
  }

  onDesignInput(): void {
    const el = this.surface()?.nativeElement;
    if (!el) return;
    this.publish(sanitiseEmailHtml(el.innerHTML));
  }

  /** Writes the sanitised layout back once editing finishes, without moving the caret on each key. */
  commitDesign(): void {
    const el = this.surface()?.nativeElement;
    if (!el) return;
    const safe = sanitiseEmailHtml(el.innerHTML);
    if (el.innerHTML !== safe) el.innerHTML = safe;
    this.publish(safe);
  }

  onSource(value: string): void {
    this.local = value;
    this.valueChange.emit(value);
  }

  sourceKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.tabLeaves = true;
      return;
    }
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || this.tabLeaves) {
      this.tabLeaves = false;
      return;
    }
    event.preventDefault();
    const box = event.target as HTMLTextAreaElement;
    box.setRangeText('  ', box.selectionStart, box.selectionEnd, 'end');
    this.onSource(box.value);
  }

  private readonly marks = (): void => {
    const el = this.surface()?.nativeElement;
    const sel = document.getSelection();
    const inside = !!el && !!sel?.anchorNode && el.contains(sel.anchorNode);
    const state = (command: string) => {
      try {
        return inside && document.queryCommandState(command);
      } catch {
        return false;
      }
    };
    this.bold.set(state('bold'));
    this.italic.set(state('italic'));
    this.underline.set(state('underline'));
  };

  private publish(safe: string): void {
    const stored = EMPTY.test(safe) ? '' : safe;
    this.local = stored;
    this.valueChange.emit(stored);
  }

  private remember(): void {
    const el = this.surface()?.nativeElement;
    const sel = document.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (el.contains(range.commonAncestorContainer)) this.range = range.cloneRange();
  }

  private restore(): void {
    const el = this.surface()?.nativeElement;
    if (!el) return;
    el.focus();
    if (!this.range) return;
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(this.range);
  }
}
