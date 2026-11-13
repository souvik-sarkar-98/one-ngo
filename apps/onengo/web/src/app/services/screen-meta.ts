import { Injectable, signal } from '@angular/core';

/**
 * What a screen tells the shell about itself once its data has loaded: the
 * label of the breadcrumb's last item, and labels for items before it that
 * only the screen knows (`record`, `definition`, `person`, …).
 */
@Injectable({ providedIn: 'root' })
export class ScreenMeta {
  readonly crumbLabel = signal<string | null>(null);
  readonly crumbLabels = signal<Readonly<Record<string, string>>>({});

  clear(): void {
    this.crumbLabel.set(null);
    this.crumbLabels.set({});
  }
}
