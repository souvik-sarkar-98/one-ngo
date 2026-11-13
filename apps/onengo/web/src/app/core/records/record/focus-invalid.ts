/** Moves focus to the first invalid control once the current change has rendered. */
export function focusFirstInvalid(): void {
  queueMicrotask(() => {
    const root = globalThis.document;
    if (!root) return;
    root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  });
}
