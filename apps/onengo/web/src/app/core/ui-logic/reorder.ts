/** A copy of `items` with the item at `from` moved to `to`; out-of-range moves return the list unchanged. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}

/**
 * Where a dragged row lands when it is dropped on the row at `over`. Dropping
 * on the upper half puts it before that row, on the lower half after it.
 */
export function dropIndex(from: number, over: number, lowerHalf: boolean): number {
  const target = lowerHalf ? over + 1 : over;
  return from < target ? target - 1 : target;
}

/** The move a key asks for on a row's drag handle: Alt+Arrow moves one place, Alt+Home/End to the ends. */
export function keyMove(key: string, alt: boolean, index: number, count: number): number | null {
  if (!alt) return null;
  const to = key === 'ArrowUp' ? index - 1 : key === 'ArrowDown' ? index + 1 : key === 'Home' ? 0 : key === 'End' ? count - 1 : null;
  return to === null || to < 0 || to >= count || to === index ? null : to;
}
