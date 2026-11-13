import { Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { asSignature, isSigned, signedLine, type SignatureValue } from '../../core/fields/files';
import type { FormValue } from '../../core/records/record/forms';
import { TranslatePipe } from '../../services/i18n';
import type { CfFieldDef } from '../cf-types';
import { SignatureView } from './signature-view';

/**
 * A signature field: a drawing pad (pointer events on a canvas, so a finger,
 * mouse or pen all work) with Clear, and, when the field asks for it, a typed
 * name for someone else signing on the device. The drawing stays in the form as a PNG and is
 * uploaded when the record is saved; the server then records who signed and
 * when. A saved signature shows its image and can only be cleared.
 */
@Component({
  selector: 'app-signature-field',
  imports: [SignatureView, TranslatePipe],
  styles: `
    :host {
      display: block;
    }
    .signature-field__pad {
      position: relative;
      height: 160px;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      background: #fff;
    }
    .signature-field__pad[data-invalid='true'] {
      border-color: #ba1a1a;
    }
    canvas,
    .signature-field__held {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      touch-action: none;
      cursor: crosshair;
    }
    .signature-field__base {
      position: absolute;
      left: 16px;
      right: 16px;
      bottom: 34px;
      border-top: 1px solid #94a3b8;
      pointer-events: none;
    }
    .signature-field__hint {
      position: absolute;
      left: 16px;
      bottom: 10px;
      font-size: 0.72rem;
      color: #94a3b8;
      pointer-events: none;
    }
    .signature-field__row {
      display: flex;
      justify-content: flex-end;
      margin-top: 6px;
    }
    .signature-field__signer {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 8px;
      font-size: 0.75rem;
      color: #374151;
    }
    .signature-field__signer input {
      height: 40px;
      padding: 0 10px;
      border: 1px solid #79747e;
      border-radius: 4px;
      font: inherit;
      font-size: 0.875rem;
    }
    .signature-field__muted {
      font-size: 0.75rem;
      color: #64748b;
    }
  `,
  template: `
    @let f = field();
    @let s = signature();
    @if (saved(); as v) {
      <app-signature-view [file]="v.file" [line]="v.line" />
      @if (!f.readOnly) {
        <div class="signature-field__row">
          <button type="button" class="app-btn" (click)="clear()">{{ 'ui.common.clear' | t }}</button>
        </div>
      }
    } @else if (f.readOnly) {
      <span class="signature-field__muted">—</span>
    } @else {
      <div class="signature-field__pad" [attr.data-invalid]="invalid()">
        @if (!inked() && s?.drawing; as src) {
          <img class="signature-field__held" [src]="src" alt="" />
        }
        <canvas
          [id]="fieldId()"
          role="img"
          tabindex="0"
          [attr.aria-label]="f.label"
          (pointerdown)="start($event)"
          (pointermove)="move($event)"
          (pointerup)="end()"
          (pointercancel)="end()"></canvas>
        <div class="signature-field__base"></div>
        <div class="signature-field__hint">{{ 'ui.fields.signature.signAbove' | t }}</div>
      </div>
      <div class="signature-field__row">
        <button type="button" class="app-btn" [disabled]="!s?.drawing" (click)="clear()">{{ 'ui.common.clear' | t }}</button>
      </div>
      @if (f.typedName) {
        <label class="signature-field__signer">
          {{ 'ui.fields.signature.signer' | t }}
          <input [value]="signer()" maxlength="200" (input)="setSigner($event)" />
        </label>
      }
    }
  `,
})
export class SignatureField {
  readonly field = input.required<CfFieldDef>();
  readonly fieldId = input.required<string>();
  readonly value = input<FormValue>(null);
  readonly invalid = input(false);
  readonly valueChange = output<SignatureValue | null>();

  readonly signature = computed(() => asSignature(this.value()));
  /** A signature the record already holds: its image and who signed when. */
  readonly saved = computed(() => {
    const s = this.signature();
    return s?.file && isSigned(s) ? { file: s.file, line: signedLine(s) } : null;
  });
  readonly signer = signal('');
  /** The pad has been drawn on since it appeared; until then a drawing the form holds shows as an image. */
  readonly inked = signal(false);
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private drawing = false;

  constructor() {
    effect(() => {
      const s = this.signature();
      if (s && !isSigned(s) && s.signedBy !== undefined) untracked(() => this.signer.set(s.signedBy ?? ''));
    });
  }

  start(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const canvas = e.currentTarget as HTMLCanvasElement;
    if (canvas !== this.canvas) this.setup(canvas);
    if (!this.ctx) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    this.drawing = true;
    this.inked.set(true);
    const [x, y] = this.point(e);
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.lineTo(x + 0.1, y + 0.1);
    this.ctx.stroke();
  }

  move(e: PointerEvent): void {
    if (!this.drawing || !this.ctx) return;
    e.preventDefault();
    for (const p of e.getCoalescedEvents?.() ?? [e]) {
      const [x, y] = this.point(p);
      this.ctx.lineTo(x, y);
    }
    this.ctx.stroke();
  }

  end(): void {
    if (!this.drawing || !this.canvas) return;
    this.drawing = false;
    this.emitDrawing(this.canvas.toDataURL('image/png'));
  }

  clear(): void {
    if (this.canvas && this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.inked.set(false);
    this.valueChange.emit(null);
  }

  setSigner(e: Event): void {
    this.signer.set((e.target as HTMLInputElement).value);
    const s = this.signature();
    if (s?.drawing) this.emitDrawing(s.drawing);
  }

  private emitDrawing(drawing: string): void {
    const name = this.signer().trim();
    this.valueChange.emit({ drawing, ...(name ? { signedBy: name } : {}) });
  }

  private point(e: PointerEvent): [number, number] {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Sizes the canvas to its box at the screen's density on first touch, keeping a drawing the form already holds. */
  private setup(canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    this.canvas = canvas;
    this.ctx = ctx;
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1d2733';
    const held = this.signature()?.drawing;
    if (held && !this.inked()) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = held;
    }
  }
}
