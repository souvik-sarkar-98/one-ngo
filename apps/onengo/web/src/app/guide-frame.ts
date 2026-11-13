import { Component, DestroyRef, ElementRef, effect, inject, viewChild } from '@angular/core';
import { TranslatePipe } from './services/i18n';
import { Session } from './services/session';

/**
 * Mounts the separate user-guide app. The guide's screens, wireframes and
 * playback live in `@onengo-guide/web`, which is served at `/guide-app/`.
 *
 * The guide cannot fetch the signed-in definition itself: the access token
 * stays here. So this frame posts the definition it already holds into the
 * guide, when the guide says it is ready and again whenever the definition
 * changes. Only this origin receives it.
 */
@Component({
  selector: 'app-guide-frame',
  imports: [TranslatePipe],
  styles: `
    :host {
      display: block;
      height: calc(100dvh - 7.5rem);
    }
    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      border-radius: 12px;
      background: #f5f7fa;
    }
  `,
  template: `<iframe #guide [title]="'ui.guide.title' | t" src="/guide-app/"></iframe>`,
})
export class GuideFrame {
  private readonly session = inject(Session);
  private readonly guide = viewChild<ElementRef<HTMLIFrameElement>>('guide');

  constructor() {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source === null || event.source !== this.guide()?.nativeElement.contentWindow) return;
      const data = event.data as { source?: unknown; type?: unknown } | null;
      if (data?.source === 'onengo-guide' && data.type === 'ready') this.send();
    };
    window.addEventListener('message', onMessage);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('message', onMessage));

    effect(() => {
      // Reading both signals makes this effect run again when the definition or the signed-in person changes.
      this.session.defs();
      this.session.me();
      this.send();
    });
  }

  /** Posts the signed-in definition and organisation name into the guide, when both are known. */
  private send(): void {
    const definitions = this.session.defs();
    const target = this.guide()?.nativeElement.contentWindow;
    if (!definitions || !target) return;
    target.postMessage(
      { source: 'onengo', type: 'definitions', definitions, organisation: this.session.me()?.tenant.name ?? '' },
      window.location.origin,
    );
  }
}
