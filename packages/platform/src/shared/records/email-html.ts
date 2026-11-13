/**
 * Allow-list sanitiser for email HTML. Keeps layout (tables, headings, lists,
 * links, images, inline styles) and drops anything that can run or load a
 * script. Placeholder values are escaped before this runs.
 */

const ALLOWED = new Set([
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'div', 'span', 'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i', 'u',
  'a', 'img', 'blockquote',
]);
const VOID = new Set(['br', 'hr', 'img']);
const DROP_WITH_CONTENT = new Set([
  'script', 'iframe', 'object', 'embed', 'style', 'template', 'noscript', 'svg', 'math',
  'textarea', 'select', 'title', 'head', 'frame', 'frameset', 'noembed', 'xmp', 'form',
]);
const LINK_SCHEMES = /^(https?:|mailto:)/i;
const HTTPS = /^https:\/\//i;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };

function decodeEntities(s: string): string {
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
  void?: boolean;
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
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*)*)>/.exec(html.slice(lt));
    if (!m) {
      if (/^<[!?]/.test(html.slice(lt))) {
        const end = html.indexOf('>', lt);
        i = end < 0 ? html.length : end + 1;
      } else {
        yield { kind: 'text', value: '<' };
        i = lt + 1;
      }
      continue;
    }
    const attrs = m[3] ?? '';
    yield { kind: m[1] ? 'close' : 'open', value: m[2]!.toLowerCase(), attrs, void: /\/\s*$/.test(attrs) };
    i = lt + m[0].length;
  }
}

function parseAttrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of raw.matchAll(re)) {
    const name = m[1]!.toLowerCase();
    if (name === '/') continue;
    out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

/** Browsers ignore control characters and whitespace inside schemes, e.g. "java\tscript:". */
function plainAddress(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
}

function cleanStyle(value: string): string {
  const style = value.replace(/\/\*[\s\S]*?\*\//g, '');
  const kept: string[] = [];
  for (const decl of style.split(';')) {
    const part = decl.trim();
    if (!part || part.includes('<') || part.includes('>') || part.includes('"')) continue;
    const folded = part.toLowerCase().replace(/[\u0000-\u0020]+/g, '');
    if (/expression\(|javascript:|@import|behavior:|-moz-binding|vbscript:|mocha:/.test(folded)) continue;
    const urls = [...part.matchAll(/url\s*\(\s*(['"]?)([^'")]+)\1\s*\)/gi)];
    if (/url\s*\(/i.test(part) && (urls.length === 0 || urls.some((u) => !HTTPS.test(plainAddress(u[2]!.trim()))))) continue;
    kept.push(part);
  }
  return kept.join('; ');
}

function localImage(value: string): string | null {
  const src = plainAddress(value).trim();
  if (!src.startsWith('/') || src.startsWith('//') || src.includes('\\') || src.includes('..')) return null;
  return /^\/api\/(?:files|organisation)\/[A-Za-z0-9._~/-]+$/.test(src) ? src : null;
}

const DOCUMENT_STYLE = new Set([
  'size', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'page-break-before', 'page-break-after', 'page-break-inside',
  'break-before', 'break-after', 'break-inside',
  'display', 'font-family', 'font-size', 'font-weight', 'font-style',
]);

/** One stylesheet: page setup, page breaks, a repeating table head, and fonts. Anything else is dropped. */
function cleanDocumentStyle(css: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/url\s*\(|expression\s*\(|javascript:|@import|@charset|@font-face|behavior:|-moz-binding|<|>/i.test(text)) return '';
  const rules: string[] = [];
  for (const block of text.split('}')) {
    const split = block.split('{');
    const head = split[0];
    const body = split.slice(1).join('{');
    if (!head || split.length < 2) continue;
    const selector = head.trim();
    if (!selector || (selector.includes('@') && !/^@page\b/i.test(selector))) continue;
    const decls: string[] = [];
    for (const decl of body.split(';')) {
      const part = decl.trim();
      const colon = part.indexOf(':');
      if (colon < 1) continue;
      const name = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).trim();
      if (!DOCUMENT_STYLE.has(name) || !value) continue;
      if (name === 'display' && value.replace(/\s/g, '').toLowerCase() !== 'table-header-group') continue;
      decls.push(`${name}: ${value}`);
    }
    if (decls.length) rules.push(`${selector} { ${decls.join('; ')}; }`);
  }
  return rules.join('\n');
}

function safeAttr(tag: string, name: string, value: string, images: 'https' | 'local'): string | null {
  if (name === 'style') {
    const style = cleanStyle(value);
    return style || null;
  }
  if (name === 'href' && tag === 'a') {
    const href = plainAddress(value);
    return LINK_SCHEMES.test(href) ? href : null;
  }
  if (name === 'src' && tag === 'img') {
    const src = plainAddress(value);
    if (images === 'local') return localImage(src);
    return HTTPS.test(src) ? src : null;
  }
  if (name === 'alt') return value.replace(/[\u0000-\u001f]/g, '');
  if (name === 'width' || name === 'height') return /^\d{1,4}(%|px)?$/.test(value.trim()) ? value.trim() : null;
  if (name === 'colspan' || name === 'rowspan') return /^(?:[1-9]|[1-4]\d|50)$/.test(value.trim()) ? value.trim() : null;
  if (name === 'border' || name === 'cellpadding' || name === 'cellspacing') return /^\d{1,3}$/.test(value.trim()) ? value.trim() : null;
  if (name === 'align') return /^(left|center|right|justify)$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
  if (name === 'valign') return /^(top|middle|bottom|baseline)$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
  if (name === 'bgcolor') return /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]{3,20})$/i.test(value.trim()) ? value.trim() : null;
  return null;
}

const EXTRA: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'alt'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  table: ['border', 'cellpadding', 'cellspacing'],
};
const SHARED = ['style', 'align', 'width', 'height', 'bgcolor', 'valign'];

function attributes(tag: string, raw: string, images: 'https' | 'local'): string {
  const allow = new Set([...SHARED, ...(EXTRA[tag] ?? [])]);
  const parts: string[] = [];
  let href = false;
  for (const [name, value] of parseAttrs(raw)) {
    if (!allow.has(name) || name.startsWith('on')) continue;
    const safe = safeAttr(tag, name, value, images);
    if (safe === null) continue;
    if (name === 'href') href = true;
    parts.push(`${name}="${escapeAttr(safe)}"`);
  }
  if (tag === 'a' && href) parts.push('rel="noopener noreferrer"');
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/** The HTML an email may carry. Unknown elements are unwrapped; scripts and their contents are removed. */
export function sanitiseEmailHtml(html: string): string {
  return sanitiseHtml(html, 'https');
}

/** Email HTML, plus one style block for paper, and images only from this organisation's files. */
export function sanitiseDocumentHtml(html: string): string {
  return sanitiseHtml(html, 'local');
}

function sanitiseHtml(html: string, images: 'https' | 'local'): string {
  const out: string[] = [];
  const open: string[] = [];
  let dropping: string | null = null;
  let depth = 0;
  let capturing = false;
  let captured = '';
  let styled = false;
  for (const t of tokens(html)) {
    if (capturing) {
      if (t.kind === 'text') captured += t.value;
      else if (t.kind === 'close' && t.value === 'style') {
        const css = cleanDocumentStyle(decodeEntities(captured));
        if (css && !styled) out.push(`<style>${escapeText(css)}</style>`);
        capturing = false;
        captured = '';
        styled = true;
      }
      continue;
    }
    if (dropping) {
      if (t.kind === 'open' && t.value === dropping) depth++;
      if (t.kind === 'close' && t.value === dropping && --depth === 0) dropping = null;
      continue;
    }
    if (t.kind === 'text') {
      out.push(escapeText(decodeEntities(t.value)));
      continue;
    }
    if (t.kind === 'open' && t.value === 'style') {
      if (images === 'local' && !t.void && !styled) capturing = true;
      else if (!t.void) {
        dropping = 'style';
        depth = 1;
      }
      continue;
    }
    if (t.kind === 'open' && DROP_WITH_CONTENT.has(t.value)) {
      if (!t.void) {
        dropping = t.value;
        depth = 1;
      }
      continue;
    }
    if (!ALLOWED.has(t.value)) continue;
    if (t.kind === 'open') {
      if (t.value === 'img') {
        const attrs = attributes('img', t.attrs ?? '', images);
        if (attrs.includes(' src="')) out.push(`<img${attrs}>`);
        continue;
      }
      if (VOID.has(t.value)) {
        out.push(`<${t.value}>`);
        continue;
      }
      const attrs = attributes(t.value, t.attrs ?? '', images);
      out.push(`<${t.value}${attrs}>`);
      if (t.void) out.push(`</${t.value}>`);
      else open.push(t.value);
    } else if (!VOID.has(t.value)) {
      const at = open.lastIndexOf(t.value);
      if (at < 0) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
    }
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}
