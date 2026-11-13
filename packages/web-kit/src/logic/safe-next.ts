const NEXT_BASE = 'https://next.invalid';
const NEXT_MAX = 2000;
const UNSAFE_NEXT = /[\u0000-\u001f\u007f\\]/;
const unsafeStart = (path: string) => !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\');

/** Returns a normalised in-app path, or `/` when the requested destination is unsafe. */
export function safeNext(next: string | null | undefined): string {
  if (typeof next !== 'string' || !next || next.length > NEXT_MAX || UNSAFE_NEXT.test(next) || unsafeStart(next)) return '/';
  let decoded = next;
  for (let index = 0; index < 3; index++) {
    let once: string;
    try {
      once = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (once === decoded) break;
    if (UNSAFE_NEXT.test(once) || unsafeStart(once)) return '/';
    decoded = once;
  }
  let url: URL;
  try {
    url = new URL(next, NEXT_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== NEXT_BASE) return '/';
  const path = `${url.pathname}${url.search}${url.hash}`;
  return unsafeStart(path) ? '/' : path;
}
