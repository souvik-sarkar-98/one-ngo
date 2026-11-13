import { signal } from '@angular/core';

/** What the person is typing; the search runs 300 ms after they stop. */
export class DebouncedSearch {
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly text = signal('');

  constructor(private readonly list: () => { search(q: string): void }) {}

  /** Follows the address bar unless the person is mid-typing. */
  sync(q: string): void {
    if (this.timer === undefined) this.text.set(q);
  }

  input(value: string): void {
    this.text.set(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.list().search(value);
    }, 300);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
