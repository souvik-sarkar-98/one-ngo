import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { GuideCatalogue } from './catalogue-store';
import { PHONE_QUERY, resolveGuide, type LayoutName } from './model';
import { Stage } from './stage';

/**
 * The locked player: one picture of a product screen, Web or Mobile chosen on
 * the screen, back and next beside the picture, and the step count under it.
 * It has no instruction paragraph. The yellow outline marks the control.
 */
@Component({
  selector: 'guide-chapter',
  imports: [RouterLink, Stage],
  template: `
    <section class="player-page">
      <a class="back" routerLink="/">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>Guide
      </a>

      @if (pending()) {
        <p class="wait">Loading your records. This topic opens when the organisation's definition arrives.</p>
      } @else {
        <h2 class="title">{{ chapter().title }} · {{ current().title }}</h2>

        <ol class="steps">
          @for (item of chapter().steps; track $index; let index = $index) {
            <li>
              <button type="button" [attr.aria-current]="index === stepIndex() ? 'step' : null" (click)="show(index)">
                <span>Step {{ index + 1 }}</span>{{ item.title }}
              </button>
            </li>
          }
        </ol>

        <div class="player" [class.mobile]="layout() === 'mobile'">
          <div class="mode" role="group" aria-label="This screen">
            <button type="button" [attr.aria-pressed]="layout() === 'web'" (click)="choose('web')">Web</button>
            <button type="button" [attr.aria-pressed]="layout() === 'mobile'" (click)="choose('mobile')">Mobile</button>
          </div>

          <div class="stage-row">
            <button type="button" class="arrow" aria-label="Back" [disabled]="stepIndex() === 0" (click)="show(stepIndex() - 1)">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" /></svg>
            </button>
            <div class="stage">
              <guide-stage
                [layout]="layout()"
                [screen]="current().screen"
                [highlight]="current().highlight ?? ''"
                [organisation]="catalogue.organisation() || 'Demo Foundation'"
                [caption]="current().title"
              />
            </div>
            <button type="button" class="arrow" aria-label="Next" [disabled]="stepIndex() === chapter().steps.length - 1" (click)="show(stepIndex() + 1)">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.59 16.59 10 18l6-6-6-6-1.41 1.41L13.17 12z" /></svg>
            </button>
          </div>

          <p class="count" aria-live="polite">{{ stepIndex() + 1 }} of {{ chapter().steps.length }}</p>
        </div>
      }
    </section>
  `,
  styles: `
    :host { display: block; }
    .player-page { max-width: 920px; margin-inline: auto; padding: 16px 16px 40px; }
    .back { display: inline-flex; align-items: center; gap: 4px; min-height: 36px; color: var(--brand); font-weight: 650; text-decoration: none; }
    .back svg, .arrow svg { width: 22px; height: 22px; fill: currentColor; }
    .title { margin: 6px 0 12px; font-size: 22px; }
    .wait { color: var(--muted); }
    a:focus-visible, button:focus-visible { outline: 3px solid #f3be26; outline-offset: 2px; }
    .steps { list-style: none; display: flex; gap: 8px; overflow-x: auto; margin: 0 0 12px; padding: 0 0 2px; }
    .steps li { flex: 1 1 0; min-width: 120px; display: flex; }
    .steps button { width: 100%; min-height: 44px; display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); font: inherit; text-align: left; cursor: pointer; color: var(--fg); }
    .steps span { color: var(--muted); font-size: 12px; }
    .steps button[aria-current="step"] { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
    .player { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .player.mobile { align-items: center; }
    .mode { align-self: flex-end; display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; background: var(--card); }
    .player.mobile .mode { align-self: center; }
    .mode button { min-height: 36px; padding: 6px 14px; border: 0; background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
    .mode button[aria-pressed="true"] { background: var(--brand); color: var(--brand-fg); }
    .stage-row { display: flex; align-items: center; gap: 12px; width: 100%; }
    .stage { flex: 1; min-width: 0; overflow-x: auto; }
    .player.mobile .stage-row { width: auto; }
    .player.mobile .stage { flex: 0 1 360px; overflow: visible; }
    .arrow { flex: 0 0 auto; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%; background: var(--brand); color: var(--brand-fg); display: grid; place-items: center; cursor: pointer; }
    .arrow:disabled { opacity: .45; cursor: default; }
    .count { margin: 0; text-align: center; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  `,
})
export class ChapterScreen {
  readonly sectionId = input.required<string>({ alias: 'section' });
  readonly chapterId = input.required<string>({ alias: 'chapter' });
  readonly step = input('1');

  readonly catalogue = inject(GuideCatalogue);
  private readonly router = inject(Router);

  /** Web or Mobile chosen on this screen; absent, the window width decides. */
  readonly choice = signal<LayoutName | null>(null);
  private readonly narrow = signal(false);
  readonly layout = computed<LayoutName>(() => this.choice() ?? (this.narrow() ? 'mobile' : 'web'));

  private readonly place = computed(() => resolveGuide(this.catalogue.sections(), this.sectionId(), this.chapterId()));
  /** True while the records section is named but the definition has not arrived yet. */
  readonly pending = computed(() => this.sectionId() === 'records' && !this.catalogue.sections().some((item) => item.id === 'records'));
  readonly chapter = computed(() => {
    const section = this.catalogue.sections().find((item) => item.id === this.place().sectionId) ?? this.catalogue.sections()[0]!;
    return section.chapters.find((item) => item.id === this.place().chapterId) ?? section.chapters[0]!;
  });
  readonly stepIndex = computed(() => {
    const raw = Number(this.step());
    const count = this.chapter().steps.length;
    return Number.isInteger(raw) && raw >= 1 && raw <= count ? raw - 1 : 0;
  });
  readonly current = computed(() => this.chapter().steps[this.stepIndex()] ?? this.chapter().steps[0]!);

  constructor() {
    const destroyRef = inject(DestroyRef);
    const media = typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null;
    this.narrow.set(media?.matches ?? false);
    const onChange = (event: MediaQueryListEvent) => this.narrow.set(event.matches);
    media?.addEventListener('change', onChange);
    destroyRef.onDestroy(() => media?.removeEventListener('change', onChange));
  }

  choose(layout: LayoutName): void {
    this.choice.set(layout);
  }

  show(index: number): void {
    const last = this.chapter().steps.length - 1;
    const next = Math.min(last, Math.max(0, index));
    void this.router.navigate([], { queryParams: { step: next + 1 }, queryParamsHandling: 'merge' });
  }
}
