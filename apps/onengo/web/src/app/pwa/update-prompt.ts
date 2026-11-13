import { Component, DestroyRef, inject, isDevMode, signal } from '@angular/core';
import { provideServiceWorker, SwUpdate } from '@angular/service-worker';
import { TranslatePipe } from '../services/i18n';

/**
 * The worker client for the update prompt, for the shell's route. In a route's
 * injector it does not register the worker; `registerWorker` does that at start.
 */
export const provideUpdates = () => provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode() });

/** "A new version is ready — Reload", once the service worker has the new version in place. */
@Component({
  selector: 'app-update-prompt',
  imports: [TranslatePipe],
  styles: `
    .update-prompt {
      position: fixed;
      left: 50%;
      bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
      z-index: 40;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 1rem;
      max-width: calc(100vw - 2rem);
      padding: 0.6rem 0.6rem 0.6rem 1rem;
      border-radius: var(--radius);
      background: var(--fg);
      color: #fff;
      box-shadow: 0 4px 16px rgb(0 0 0 / 20%);
    }
    :host-context(.shell--bottom) .update-prompt {
      bottom: calc(80px + env(safe-area-inset-bottom, 0px));
    }
    .update-prompt button {
      border: 0;
      background: transparent;
      color: #9fd0f3;
      font-weight: 600;
    }
  `,
  template: `
    @if (ready()) {
      <div class="update-prompt" role="status">
        <span>{{ 'ui.pwa.updateReady' | t }}</span>
        <button type="button" (click)="reload()">{{ 'ui.pwa.reload' | t }}</button>
      </div>
    }
  `,
})
export class UpdatePrompt {
  readonly ready = signal(false);

  constructor() {
    const updates = inject(SwUpdate);
    if (!updates.isEnabled) return;
    const versions = updates.versionUpdates.subscribe((e) => e.type === 'VERSION_READY' && this.ready.set(true));
    const broken = updates.unrecoverable.subscribe(() => this.ready.set(true));
    const check = () => document.visibilityState === 'visible' && updates.checkForUpdate().catch(() => undefined);
    document.addEventListener('visibilitychange', check);
    inject(DestroyRef).onDestroy(() => {
      versions.unsubscribe();
      broken.unsubscribe();
      document.removeEventListener('visibilitychange', check);
    });
  }

  reload(): void {
    location.reload();
  }
}
