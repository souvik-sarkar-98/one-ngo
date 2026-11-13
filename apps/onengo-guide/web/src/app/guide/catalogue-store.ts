import { Injectable, computed, signal } from '@angular/core';
import { GUIDE } from './catalogue';
import type { GuideSection } from './model';
import { projectDefinitions, type GuideDefinitions } from './project';

/** Written App chapters that the organisation's own definition replaces once it arrives. */
export const RECORD_CHAPTERS: ReadonlySet<string> = new Set(['find', 'record', 'edit', 'create', 'donors', 'home', 'pages', 'actions', 'print', 'bulk', 'workflows']);

interface GuideMessage {
  source?: unknown;
  type?: unknown;
  definitions?: unknown;
  organisation?: unknown;
}

function isDefinitions(value: unknown): value is GuideDefinitions {
  const candidate = value as Partial<GuideDefinitions> | null;
  return !!candidate && Array.isArray(candidate.recordTypes) && typeof candidate.workflows === 'object' && candidate.workflows !== null;
}

/** The organisation's brand colour, if it is a six-digit hex value. */
function applyBrand(brand: string | undefined): void {
  if (brand && /^#[0-9a-f]{6}$/i.test(brand)) document.documentElement.style.setProperty('--brand', brand);
}

/**
 * Holds the guide's chapters. Written chapters always exist. Once the signed-in
 * organisation posts its definition, the records chapters come from that
 * definition. The guide sends `ready` to its parent so the definition is posted
 * even when the guide loads after the parent.
 */
@Injectable({ providedIn: 'root' })
export class GuideCatalogue {
  readonly definitions = signal<GuideDefinitions | null>(null);
  readonly organisation = signal('');

  readonly sections = computed<readonly GuideSection[]>(() => {
    const defs = this.definitions();
    const generated = defs ? projectDefinitions(defs) : null;
    if (!generated) return GUIDE;
    const written = GUIDE.map((section) =>
      section.id === 'app' ? { ...section, chapters: section.chapters.filter((chapter) => !RECORD_CHAPTERS.has(chapter.id)) } : section,
    );
    return [...written, generated];
  });

  constructor() {
    if (typeof window === 'undefined' || window.parent === window) return;
    window.addEventListener('message', (event) => this.receive(event));
    window.parent.postMessage({ source: 'onengo-guide', type: 'ready' }, window.location.origin);
  }

  private receive(event: MessageEvent): void {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const data = event.data as GuideMessage | null;
    if (data?.source !== 'onengo' || data.type !== 'definitions' || !isDefinitions(data.definitions)) return;
    applyBrand(data.definitions.theme?.brand ?? undefined);
    this.organisation.set(typeof data.organisation === 'string' ? data.organisation : '');
    this.definitions.set(data.definitions);
  }
}
