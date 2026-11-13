/** Enter opens a row in both layouts; Space does too on elements that are not buttons. */
export function opensRow(e: KeyboardEvent): boolean {
  if (e.key === 'Enter') return true;
  return e.key === ' ' && !(e.target instanceof HTMLButtonElement);
}
