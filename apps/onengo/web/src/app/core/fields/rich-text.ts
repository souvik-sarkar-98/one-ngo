import { RICH_TEXT_ATTRIBUTES, RICH_TEXT_ELEMENTS, RICH_TEXT_LINK_SCHEMES, richTextToPlain, sanitiseRichText } from '../server';

/**
 * Rich-text rules for the web app: the server's own allow-list and sanitiser,
 * so what the editor keeps is exactly what the server will store.
 */
export { RICH_TEXT_ATTRIBUTES, RICH_TEXT_ELEMENTS, RICH_TEXT_LINK_SCHEMES, richTextToPlain, sanitiseRichText };

const BROWSER_BLOCKS: Record<string, string> = { div: 'p', h1: 'h3', h2: 'h3', h5: 'h4', h6: 'h4' };

/**
 * Cleans what the editor holds or what was pasted into it. Browsers and word
 * processors write their own blocks (div, h1, h2…); they become the allowed
 * ones first so lines and headings survive, then the allow-list applies.
 */
export function cleanRichText(html: string): string {
  const mapped = html.replace(/<(\/?)(div|h1|h2|h5|h6)\b[^>]*>/gi, (_, close: string, tag: string) => `<${close}${BROWSER_BLOCKS[tag.toLowerCase()]}>`);
  const clean = sanitiseRichText(mapped);
  return richTextToPlain(clean) ? clean : '';
}

/** A link address the allow-list keeps, or null; a bare address such as example.org gains https://. */
export function safeLinkHref(input: string): string | null {
  const href = input.trim();
  if (!href) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(href) ? `mailto:${href}` : `https://${href}`;
  return (RICH_TEXT_LINK_SCHEMES as readonly string[]).some((s) => withScheme.toLowerCase().startsWith(s)) ? withScheme : null;
}
