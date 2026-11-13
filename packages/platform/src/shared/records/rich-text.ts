/**
 * Allow-list sanitiser for rich-text fields. Keeps only the elements below;
 * links keep only an http, https or mailto href and gain
 * rel="noopener noreferrer". Every other element is removed (its text kept),
 * except the ones in DROP_WITH_CONTENT, whose content goes too. No attribute
 * other than a link's href survives.
 */
export const RICH_TEXT_ELEMENTS = ['p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'h3', 'h4', 'blockquote', 'a'] as const;
/** The only attributes that survive, by element; `rel` is always set by the sanitiser, never kept from the input. */
export const RICH_TEXT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = { a: ['href', 'rel'] };
export const RICH_TEXT_LINK_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

const ALLOWED = new Set<string>(RICH_TEXT_ELEMENTS);
const VOID = new Set(['br']);
const RENAME: Record<string, string> = { b: 'strong', i: 'em' };
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'textarea', 'select', 'title', 'head', 'frame', 'frameset', 'noembed', 'xmp',
]);
const BLOCK = new Set(['p', 'br', 'li', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'div', 'tr', 'td', 'th', 'h1', 'h2', 'h5', 'h6']);
const SAFE_LINK = new RegExp(`^(${RICH_TEXT_LINK_SCHEMES.join('|')})`, 'i');

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+[0-9]*);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

interface Token {
  kind: 'text' | 'open' | 'close';
  value: string;
  attrs?: string;
}

function* tokens(html: string): Generator<Token> {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      yield { kind: 'text', value: html.slice(i) };
      return;
    }
    if (lt > i) yield { kind: 'text', value: html.slice(i, lt) };
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(html.slice(lt));
    if (!m) {
      // A stray '<' or a declaration such as <!doctype>: drop declarations, keep '<' as text.
      if (/^<[!?]/.test(html.slice(lt))) {
        const end = html.indexOf('>', lt);
        i = end < 0 ? html.length : end + 1;
      } else {
        yield { kind: 'text', value: '<' };
        i = lt + 1;
      }
      continue;
    }
    yield { kind: m[1] ? 'close' : 'open', value: m[2]!.toLowerCase(), attrs: m[3] };
    i = lt + m[0].length;
  }
}

function hrefOf(attrs: string): string | null {
  const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  if (!m) return null;
  // Browsers ignore control characters and whitespace inside schemes, e.g. "java\tscript:".
  const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  return SAFE_LINK.test(href) ? href : null;
}

export function sanitiseRichText(html: string): string {
  const out: string[] = [];
  const open: string[] = [];
  let dropping: string | null = null;
  let depth = 0;
  for (const t of tokens(html)) {
    if (dropping) {
      if (t.kind === 'open' && t.value === dropping) depth++;
      if (t.kind === 'close' && t.value === dropping && --depth === 0) dropping = null;
      continue;
    }
    if (t.kind === 'text') {
      out.push(escapeText(decodeEntities(t.value)));
      continue;
    }
    if (t.kind === 'open' && DROP_WITH_CONTENT.has(t.value)) {
      if (!/\/\s*$/.test(t.attrs ?? '')) {
        dropping = t.value;
        depth = 1;
      }
      continue;
    }
    const tag = RENAME[t.value] ?? t.value;
    if (!ALLOWED.has(tag)) continue;
    if (t.kind === 'open') {
      if (VOID.has(tag)) {
        out.push('<br>');
        continue;
      }
      if (tag === 'a') {
        const href = hrefOf(t.attrs ?? '');
        out.push(href ? `<a href="${escapeAttr(href)}" rel="noopener noreferrer">` : '<a>');
      } else out.push(`<${tag}>`);
      open.push(tag);
    } else if (!VOID.has(tag)) {
      const at = open.lastIndexOf(tag);
      if (at < 0) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
    }
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}

/** The words of a rich-text value, for search, templates and exports. */
export function richTextToPlain(html: string): string {
  const parts: string[] = [];
  let dropping: string | null = null;
  for (const t of tokens(html)) {
    if (dropping) {
      if (t.kind === 'close' && t.value === dropping) dropping = null;
      continue;
    }
    if (t.kind === 'open' && DROP_WITH_CONTENT.has(t.value)) dropping = t.value;
    else if (t.kind === 'text') parts.push(decodeEntities(t.value));
    else if (BLOCK.has(t.value)) parts.push(' ');
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}
