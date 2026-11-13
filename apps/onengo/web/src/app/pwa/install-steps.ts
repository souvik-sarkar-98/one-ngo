import { Component, input } from '@angular/core';
import { TranslatePipe } from '../services/i18n';

/** The steps a browser shows itself, when it will not install from a button. */
@Component({
  selector: 'app-install-steps',
  imports: [TranslatePipe],
  styles: `
    .install-steps {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .install-steps li {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 2px;
    }
    .install-steps li + li {
      border-top: 1px solid var(--line, #d8dee6);
    }
    .install-steps span {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--brand, #1f5f8b) 14%, var(--card, #fff));
      color: var(--brand, #1f5f8b);
      font-size: 0.85rem;
      font-weight: 700;
    }
    p {
      margin: 0;
    }
  `,
  template: `
    @if (offer() === 'ios') {
      <ol class="install-steps">
        <li><span>1</span>{{ 'ui.pwa.installIosShare' | t }}</li>
        <li><span>2</span>{{ 'ui.pwa.installIosAdd' | t }}</li>
      </ol>
    } @else if (offer() === 'browser') {
      <p>{{ 'ui.pwa.installBrowser' | t }}</p>
    }
  `,
})
export class InstallSteps {
  readonly offer = input<'ios' | 'browser' | null>(null);
}
