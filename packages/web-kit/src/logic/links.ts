/** The parts of a click that decide whether the browser should handle a link itself. */
export interface ClickLike {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Whether a link click should move within the app; modified and middle clicks are left to the browser. */
export function opensInPlace(event: ClickLike): boolean {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

/** A count as a badge shows it; nothing for zero. */
export function badgeText(count: number | undefined): string {
  if (!count || count < 0) return '';
  return count > 99 ? '99+' : String(count);
}

/** Up to two initials of a name or address, for an account button. */
export function initials(name: string): string {
  const words = name.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  return words.slice(0, 2).map((word) => [...word][0]!.toLocaleUpperCase()).join('');
}
