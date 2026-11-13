import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { GUIDE } from './catalogue';
import { RECORD_CHAPTERS, GuideCatalogue } from './catalogue-store';
import type { GuideChapter, GuideSection } from './model';

/** One row on the home: a chapter the row opens at step 1. */
interface HomeRow {
  sectionId: string;
  chapterId: string;
  title: string;
  detail: string;
}

/** One search result: a step, or a whole chapter when the chapter name matches. */
interface HomeResult {
  sectionId: string;
  chapterId: string;
  stepIndex: number;
  title: string;
  detail: string;
}

const MAX_RESULTS = 12;

const EVERYDAY: HomeRow[] = [
  { sectionId: 'app', chapterId: 'sign-in', title: 'Sign in', detail: 'The organisation card' },
  { sectionId: 'app', chapterId: 'inbox', title: 'Inbox', detail: 'Approvals and notifications' },
  { sectionId: 'app', chapterId: 'account', title: 'Your account', detail: 'Name and email' },
  { sectionId: 'app', chapterId: 'language', title: 'Language', detail: 'English, Hindi, Tamil, Telugu, Bengali, Marathi' },
];

const SETUP: HomeRow[] = [
  { sectionId: 'builder', chapterId: 'catalogue', title: 'Builder', detail: 'Record types, workflows, list views, pages and the theme' },
  { sectionId: 'organisation', chapterId: 'information', title: 'Organisation', detail: 'Name and code' },
  { sectionId: 'connectors', chapterId: 'shape', title: 'Connectors', detail: 'The connector list' },
];

function matches(text: string | undefined, query: string): boolean {
  return !!text && text.toLowerCase().includes(query);
}

/**
 * The guide's front page. It has no bar and no picture; it lists topics and
 * searches steps. Your records follows the posted definition, and falls back to
 * the written records chapters until that definition arrives.
 */
@Component({
  selector: 'guide-home',
  imports: [RouterLink],
  template: `
    <section class="home">
      <h1>{{ organisation() }}</h1>
      <p class="pick">What do you want to do?</p>

      <label class="finder">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 5 1.5-1.5-5-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" /></svg>
        <span class="sr">Search the guide</span>
        <input type="search" placeholder="Search, for example receipt, paid or donor" [value]="query()" (input)="search($event)" />
      </label>

      @if (query().trim()) {
        @if (results().length) {
          <div class="card">
            @for (result of results(); track result.sectionId + result.chapterId + result.stepIndex) {
              <a [routerLink]="['/', result.sectionId, result.chapterId]" [queryParams]="{ step: result.stepIndex + 1 }">
                <span><b>{{ result.title }}</b><small>{{ result.detail }}</small></span><span class="go" aria-hidden="true">›</span>
              </a>
            }
          </div>
        } @else {
          <p class="empty">Nothing matches. Try paid, receipt, donor or inbox.</p>
        }
      } @else {
        @if (start(); as row) {
          <section class="start">
            <p class="kicker">Start here</p>
            <h2>{{ row.title }}</h2>
            <p>{{ row.detail }}</p>
            <a class="btn" [routerLink]="['/', row.sectionId, row.chapterId]">Start</a>
          </section>
        }

        @for (group of groups(); track group.label) {
          <section class="group">
            <h2>{{ group.label }}</h2>
            <div class="card">
              @for (row of group.rows; track row.sectionId + row.chapterId) {
                <a [routerLink]="['/', row.sectionId, row.chapterId]">
                  <span><b>{{ row.title }}</b><small>{{ row.detail }}</small></span><span class="go" aria-hidden="true">›</span>
                </a>
              }
            </div>
          </section>
        }
      }
    </section>
  `,
  styles: `
    :host { display: block; }
    .home { max-width: 720px; margin-inline: auto; padding: 20px 16px 40px; }
    h1 { margin: 0 0 4px; font-size: 28px; }
    .pick { margin: 0 0 14px; color: var(--muted); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .finder { position: relative; display: block; margin: 0 0 16px; }
    .finder svg { position: absolute; left: 12px; top: 50%; width: 18px; height: 18px; transform: translateY(-50%); fill: var(--muted); pointer-events: none; }
    .finder input { width: 100%; min-height: 44px; border: 1px solid var(--line); border-radius: 12px; padding: 0 14px 0 38px; font: inherit; color: var(--fg); background: var(--card); }
    .finder input:focus, a:focus-visible, .btn:focus-visible { outline: 3px solid #f3be26; outline-offset: 2px; }
    .start { margin: 0 0 20px; padding: 14px 16px; border: 1px solid color-mix(in srgb, var(--brand) 25%, #fff); border-radius: 14px; background: color-mix(in srgb, var(--brand) 6%, #fff); }
    .kicker { margin: 0; color: var(--brand); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .start h2 { margin: 2px 0 4px; font-size: 18px; }
    .start p { margin: 0 0 12px; color: var(--muted); line-height: 1.45; }
    .btn { display: inline-flex; align-items: center; min-height: 44px; padding: 8px 16px; border-radius: 999px; background: var(--brand); color: var(--brand-fg); font-weight: 700; text-decoration: none; }
    .group { margin: 0 0 18px; }
    .group h2 { margin: 0 0 8px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--brand); }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
    .card a { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 10px 14px; border-top: 1px solid var(--line); color: var(--fg); text-decoration: none; }
    .card a:first-child { border-top: 0; }
    .card a:hover { background: color-mix(in srgb, var(--brand) 5%, #fff); }
    .card b { display: block; font-size: 15px; }
    .card small { display: block; color: var(--muted); font-size: 13px; }
    .card a > span:first-child { flex: 1; min-width: 0; }
    .go { color: var(--muted); font-size: 18px; }
    .empty { color: var(--muted); }
  `,
})
export class GuideHome {
  private readonly catalogue = inject(GuideCatalogue);
  readonly query = signal('');

  readonly organisation = computed(() => this.catalogue.organisation() || 'User guide');

  /** The first row of Your records: the topic the Start here card opens. */
  readonly start = computed<HomeRow | null>(() => this.recordRows()[0] ?? null);

  readonly groups = computed(() =>
    [
      { label: 'Your records', rows: this.recordRows() },
      { label: 'Everyday', rows: EVERYDAY },
      { label: 'Setup', rows: SETUP },
    ].filter((group) => group.rows.length > 0),
  );

  readonly results = computed<HomeResult[]>(() => {
    const query = this.query().trim().toLowerCase();
    if (!query) return [];
    const found: HomeResult[] = [];
    for (const section of this.catalogue.sections()) {
      for (const chapter of section.chapters) {
        const steps = chapter.steps.flatMap((step, stepIndex) => (matches(step.title, query) ? [{ stepIndex, title: step.title }] : []));
        const detail = chapter.title;
        if (steps.length) {
          for (const step of steps) found.push({ sectionId: section.id, chapterId: chapter.id, stepIndex: step.stepIndex, title: step.title, detail });
        } else if (matches(chapter.title, query) || matches(chapter.summary, query)) {
          found.push({ sectionId: section.id, chapterId: chapter.id, stepIndex: 0, title: chapter.title, detail: this.sectionLabel(section) });
        }
      }
    }
    return found.slice(0, MAX_RESULTS);
  });

  search(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /** Your records: the generated chapters when a definition has arrived, otherwise the written records chapters. */
  private recordRows(): HomeRow[] {
    const generated = this.catalogue.sections().find((section) => section.id === 'records');
    if (generated) {
      return generated.chapters
        .filter((chapter) => chapter.id !== 'groups')
        .map((chapter) => this.row('records', chapter));
    }
    const written = GUIDE.find((section) => section.id === 'app')?.chapters.filter((chapter) => RECORD_CHAPTERS.has(chapter.id)) ?? [];
    return written.map((chapter) => this.row('app', chapter));
  }

  private row(sectionId: string, chapter: GuideChapter): HomeRow {
    return { sectionId, chapterId: chapter.id, title: chapter.title, detail: chapter.summary ?? '' };
  }

  private sectionLabel(section: GuideSection): string {
    return section.label;
  }
}
