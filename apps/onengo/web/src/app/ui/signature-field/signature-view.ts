import { Component, effect, inject, input, signal } from '@angular/core';
import { Files } from '../../services/files';
import { TranslatePipe } from '../../services/i18n';

/** A saved signature: the stored image and "Signed by … on …". */
@Component({
  selector: 'app-signature-view',
  imports: [TranslatePipe],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    img {
      max-width: 220px;
      max-height: 80px;
      object-fit: contain;
      align-self: flex-start;
    }
    .signature-view__line {
      font-size: 0.75rem;
      color: #64748b;
    }
  `,
  template: `
    @if (src()) {
      <img [src]="src()" [alt]="line()" />
    } @else if (failed()) {
      <span class="signature-view__line">{{ 'ui.common.somethingWentWrong' | t }}</span>
    }
    <span class="signature-view__line">{{ line() }}</span>
  `,
})
export class SignatureView {
  private readonly files = inject(Files);
  readonly file = input.required<string>();
  readonly line = input.required<string>();
  readonly src = signal<string | null>(null);
  readonly failed = signal(false);

  constructor() {
    effect(() => {
      const id = this.file();
      this.failed.set(false);
      this.files.image(id).then(
        (src) => this.file() === id && this.src.set(src),
        () => this.failed.set(true),
      );
    });
  }
}
