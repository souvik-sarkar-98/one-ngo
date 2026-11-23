import { Directive, ElementRef, afterNextRender, booleanAttribute, inject, input } from '@angular/core';

/**
 * Brings a notice to the person the moment it appears. An error takes focus,
 * so the page moves to it and screen readers announce it. Any other notice
 * scrolls into view only when it is off screen, so a save made while looking
 * at the editor does not jump the page.
 *
 * Put it on a notice that is rendered only while it applies (`@if`, or a
 * `@for` keyed on the result), so each new appearance triggers it again.
 */
@Directive({
  selector: '[appNotice]',
  host: { tabindex: '-1' },
})
export class NoticeFocus {
  /** Errors are focused; everything else is only scrolled to when off screen. */
  readonly error = input(false, { alias: 'appNoticeError', transform: booleanAttribute });

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      if (this.error()) {
        el.focus();
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > globalThis.innerHeight) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }
}
