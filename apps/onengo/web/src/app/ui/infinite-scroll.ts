import { Directive, ElementRef, inject, output, type OnDestroy, type OnInit } from '@angular/core';

/**
 * Emits when the element comes within 400px of the viewport. Both layouts put
 * one of these after their rows and ask for the next page when it fires.
 */
@Directive({ selector: '[appInfiniteScroll]' })
export class InfiniteScrollDirective implements OnInit, OnDestroy {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private observer: IntersectionObserver | null = null;
  readonly visible = output<void>();

  ngOnInit(): void {
    if (typeof IntersectionObserver === 'undefined') return;
    this.observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && this.visible.emit(), { rootMargin: '400px' });
    this.observer.observe(this.el.nativeElement);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
