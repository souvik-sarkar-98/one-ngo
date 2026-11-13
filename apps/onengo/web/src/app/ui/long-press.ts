import { DestroyRef, Directive, ElementRef, inject, output } from '@angular/core';

const HOLD_MS = 500;
const SLOP_PX = 10;

/** Emits after a press held still for half a second, and swallows the click that ends it before anything inside sees it. */
@Directive({
  selector: '[appLongPress]',
  host: {
    '(pointerdown)': 'down($event)',
    '(pointermove)': 'move($event)',
    '(pointerup)': 'cancel()',
    '(pointerleave)': 'cancel()',
    '(pointercancel)': 'cancel()',
    '(contextmenu)': 'pressed && $event.preventDefault()',
  },
})
export class LongPress {
  readonly appLongPress = output<void>();
  pressed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private start = { x: 0, y: 0 };

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const swallow = (e: Event) => {
      if (!this.pressed) return;
      this.pressed = false;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('click', swallow, true);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.timer);
      el.removeEventListener('click', swallow, true);
    });
  }

  down(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.pressed = false;
    this.start = { x: e.clientX, y: e.clientY };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.pressed = true;
      this.appLongPress.emit();
    }, HOLD_MS);
  }

  move(e: PointerEvent): void {
    if (Math.hypot(e.clientX - this.start.x, e.clientY - this.start.y) > SLOP_PX) clearTimeout(this.timer);
  }

  cancel(): void {
    clearTimeout(this.timer);
  }
}
