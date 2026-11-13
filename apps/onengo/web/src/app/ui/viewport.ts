import { Injectable, signal, type WritableSignal } from '@angular/core';

/** Below this width record lists use the phone layout; it matches the app shell's breakpoint. */
export const NARROW_QUERY = '(max-width: 759.98px)';
/** From this width tables show all their columns. */
export const WIDE_QUERY = '(min-width: 1100px)';

function watch(query: string): WritableSignal<boolean> {
  const list = typeof matchMedia === 'function' ? matchMedia(query) : null;
  const value = signal(list?.matches ?? false);
  list?.addEventListener('change', (e) => value.set(e.matches));
  return value;
}

/** The two size signals every layout decision reads (phone below 760px, desktop from 1100px). */
@Injectable({ providedIn: 'root' })
export class Viewport {
  /** Whether the screen is phone-sized. */
  readonly narrow = watch(NARROW_QUERY);
  /** Whether the screen is desktop-sized. */
  readonly wide = watch(WIDE_QUERY);
}
