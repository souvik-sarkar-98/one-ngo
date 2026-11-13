import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { RICH_TEXT_ATTRIBUTES, RICH_TEXT_ELEMENTS, RICH_TEXT_LINK_SCHEMES, cleanRichText } from '../../core/fields/rich-text';

const ELEMENTS = new Set<string>(RICH_TEXT_ELEMENTS);

/** Keeps only allowed elements and attributes in a parsed tree; anything else is dropped. */
function prune(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) {
      child.remove();
      continue;
    }
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (!ELEMENTS.has(tag)) {
      el.remove();
      continue;
    }
    const allowed = RICH_TEXT_ATTRIBUTES[tag] ?? [];
    for (const a of Array.from(el.attributes)) if (!allowed.includes(a.name)) el.removeAttribute(a.name);
    const href = el.getAttribute('href');
    if (href !== null && !(RICH_TEXT_LINK_SCHEMES as readonly string[]).some((s) => href.trim().toLowerCase().startsWith(s))) el.removeAttribute('href');
    if (tag === 'a') {
      el.setAttribute('rel', 'noopener noreferrer');
      el.setAttribute('target', '_blank');
    }
    prune(el);
  }
}

/**
 * Puts rich text on screen: cleaned with the shared allow-list, then parsed in
 * an inert document and checked again node by node before it is attached.
 * This is the second guard in place of Angular's HTML sanitiser, whose code
 * would otherwise be part of every screen's first download.
 */
export function placeRichText(target: HTMLElement, html: string): void {
  const doc = new DOMParser().parseFromString(`<body>${cleanRichText(html)}</body>`, 'text/html');
  prune(doc.body);
  target.replaceChildren(...Array.from(doc.body.childNodes, (n) => document.importNode(n, true)));
}

/** Shows a rich-text value, e.g. `<div [appRichText]="html"></div>`; a new `richTextVersion` puts it back even when unchanged. */
@Directive({ selector: '[appRichText]' })
export class RichTextView {
  readonly appRichText = input.required<string>();
  readonly richTextVersion = input(0);

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(() => {
      this.richTextVersion();
      placeRichText(host, this.appRichText());
    });
  }
}
