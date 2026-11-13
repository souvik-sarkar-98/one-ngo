import { Component, inject } from '@angular/core';
import { TranslatePipe } from '../services/i18n';
import { Connectivity } from './connectivity';

/** Says the app is offline: what is on screen stays, and saves are blocked until the connection is back. */
@Component({
  selector: 'app-offline-banner',
  imports: [TranslatePipe],
  styles: `
    .offline-banner {
      margin: 0;
      padding: 0.6rem 1.25rem;
      background: #fdf1dc;
      color: var(--warn);
      border-bottom: 1px solid #f0d9a8;
      font-size: 0.9rem;
    }
  `,
  template: `
    @if (!connectivity.online()) {
      <p class="offline-banner" role="status">{{ 'ui.pwa.offline' | t }}</p>
    }
  `,
})
export class OfflineBanner {
  readonly connectivity = inject(Connectivity);
}
