import { Component, computed, input } from '@angular/core';
import { draftPairs, themePairs, type ThemeColours } from '../../../core/builder/contrast';
import { formatMoney } from '../../../core/i18n/i18n';
import { TranslatePipe } from '../../../services/i18n';

const VARS: Record<string, string> = {
  brand: '--brand',
  brandForeground: '--brand-fg',
  background: '--bg',
  surface: '--card',
  text: '--fg',
  muted: '--muted',
  line: '--line',
  radius: '--radius',
};

/** The app's own controls drawn with the draft's colours, and the contrast of each text colour on its background. */
@Component({
  selector: 'app-theme-preview',
  imports: [TranslatePipe],
  styleUrl: './preview.css',
  styles: `
    .th { background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; margin-bottom: .75rem; }
    .th__bar { background: var(--brand); color: var(--brand-fg); padding: .5rem .8rem; font-weight: 600; }
    .th__body { padding: .7rem .8rem; }
    .th__chips { display: flex; gap: .35rem; margin-bottom: .6rem; }
    .th__chip { border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: .1rem .6rem; font-size: .8rem; }
    .th__chip--on { background: var(--brand); border-color: var(--brand); color: var(--brand-fg); }
    .th .card { display: flex; gap: .6rem; align-items: center; margin-bottom: .6rem; padding: .6rem .7rem; }
    .th__grow { flex: 1; }
    .th__link { color: var(--brand); text-decoration: underline; }
    .th__swatch { display: inline-block; width: .9rem; height: .9rem; border-radius: 3px; border: 1px solid var(--line); vertical-align: -2px; margin-right: .15rem; }
  `,
  template: `
    <section class="pv" aria-labelledby="theme-preview-title">
      <h3 class="pv__title" id="theme-preview-title">{{ 'ui.builder.preview.title' | t }}</h3>
      <div class="th" [style]="vars()">
        <div class="th__bar">{{ 'ui.builder.preview.sampleList' | t }}</div>
        <div class="th__body">
          <div class="th__chips">
            <span class="th__chip">{{ 'ui.builder.preview.sampleChip' | t }}</span>
            <span class="th__chip th__chip--on">{{ 'ui.builder.preview.sampleChipOn' | t }}</span>
          </div>
          <div class="card">
            <div class="th__grow">
              <b>{{ 'ui.builder.preview.sampleName' | t }}</b>
              <div class="muted">{{ amount }}</div>
            </div>
            <span class="badge warn">{{ 'ui.builder.preview.sampleBadge' | t }}</span>
          </div>
          <div class="pv__row">
            <button type="button" class="primary" tabindex="-1">{{ 'ui.builder.preview.sampleAction' | t }}</button>
            <button type="button" tabindex="-1">{{ 'ui.common.edit' | t }}</button>
            <span class="th__link">{{ 'ui.builder.preview.sampleLink' | t }}</span>
          </div>
        </div>
      </div>
      <h4 class="pv__title">{{ 'ui.builder.contrast.title' | t }}</h4>
      <ul class="pv__list">
        @for (p of pairs(); track p.id) {
          <li [class.pv__bad]="!p.contrast || p.contrast.level === 'fail' || p.contrast.level === 'large'">
            <span class="th__swatch" [style.background]="p.foreground"></span><span class="th__swatch" [style.background]="p.background"></span>
            {{ 'ui.builder.contrast.' + p.id | t }}:
            @if (p.contrast; as c) {
              {{ 'ui.builder.contrast.ratio' | t: { ratio: c.ratio } }} ({{ 'ui.builder.contrast.level.' + c.level | t }})
            } @else {
              {{ 'ui.builder.contrast.notColour' | t }}
            }
          </li>
        }
      </ul>
      <p class="pv__note">{{ 'ui.builder.contrast.hint' | t }}</p>
    </section>
  `,
})
export class ThemePreview {
  readonly value = input<unknown>();
  readonly body = input<Record<string, unknown> | null>(null);
  /** When set, contrast uses the draft values alone and a blank token does not fall back to the page theme. */
  readonly exact = input(false);
  readonly amount = formatMoney(5000);
  readonly pairs = computed(() => {
    const body = (this.body() ?? {}) as ThemeColours;
    return this.exact() ? draftPairs(body) : themePairs(body);
  });
  readonly vars = computed(() => {
    const b = this.body() ?? {};
    const exact = this.exact();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(VARS)) {
      if (typeof b[k] !== 'string') continue;
      const value = b[k] as string;
      if (value) out[v] = value;
      else if (exact) out[v] = k === 'radius' ? '0px' : 'transparent';
    }
    return out;
  });
}
