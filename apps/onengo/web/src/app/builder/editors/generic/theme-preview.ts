import { Component, computed, input, output, signal } from '@angular/core';
import { draftPairs, themePairs, type ThemeColours } from '../../../core/builder/contrast';
import type { ThemeSuggestion } from '../../../core/admin/theme-form';
import { formatMoney } from '../../../core/i18n/i18n';
import { TranslatePipe } from '../../../services/i18n';
import { Btn } from '@onengo/web-kit';

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

type PreviewSurface = 'list' | 'form' | 'signIn';

/** The app's own controls drawn with the draft's colours, and the contrast of each text colour on its background. */
@Component({
  selector: 'app-theme-preview',
  imports: [Btn, TranslatePipe],
  host: { '[class.theme-preview--panel]': 'panel()' },
  styleUrl: './preview.css',
  styles: `
    :host.theme-preview--panel .pv { border: 0; padding: 0; margin: 0; background: transparent; }
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
    .th__form { display: grid; gap: .5rem; }
    .th__field span { display: block; font-size: .75rem; font-weight: 600; margin-bottom: .2rem; }
    .th__input { border: 1px solid var(--line); border-radius: var(--radius); padding: .35rem .5rem; background: var(--card); font: inherit; font-size: .8rem; }
    .th__signin { text-align: center; padding: 1rem .8rem 1.2rem; }
    .th__signin-title { font-weight: 700; margin-bottom: .75rem; }
    .pv__tabs { display: flex; flex-wrap: wrap; gap: .35rem; margin: 0 0 .6rem; }
    .pv__tab { font: inherit; font-size: .75rem; padding: .2rem .65rem; border-radius: 999px; border: 1px solid var(--line); background: var(--card); cursor: pointer; }
    .pv__tab--on { background: var(--brand); border-color: var(--brand); color: var(--brand-fg); }
    .pv__head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; flex-wrap: wrap; margin-top: .75rem; }
    .pv__summary { margin: 0; font-size: .8rem; color: var(--muted); }
    .pv__fix { font: inherit; font-size: inherit; color: var(--brand); background: none; border: 0; padding: 0; margin-inline-start: .35rem; text-decoration: underline; cursor: pointer; }
    .pv__apply { font: inherit; font-size: 0.78rem; margin-inline-start: 0.35rem; padding: 0.2rem 0.55rem; border-radius: var(--radius); border: 1px solid var(--brand); background: var(--brand); color: var(--brand-fg); cursor: pointer; }
  `,
  template: `
    <section class="pv" aria-labelledby="theme-preview-title">
      <h3 class="pv__title" id="theme-preview-title">{{ 'ui.builder.preview.title' | t }}</h3>
      @if (adminTabs()) {
        <div class="pv__tabs" role="tablist" [attr.aria-label]="'ui.builder.preview.title' | t">
          <button type="button" class="pv__tab" [class.pv__tab--on]="surface() === 'list'" role="tab" [attr.aria-selected]="surface() === 'list'" (click)="surface.set('list')">
            {{ 'ui.admin.theme.preview.list' | t }}
          </button>
          <button type="button" class="pv__tab" [class.pv__tab--on]="surface() === 'form'" role="tab" [attr.aria-selected]="surface() === 'form'" (click)="surface.set('form')">
            {{ 'ui.admin.theme.preview.form' | t }}
          </button>
          <button type="button" class="pv__tab" [class.pv__tab--on]="surface() === 'signIn'" role="tab" [attr.aria-selected]="surface() === 'signIn'" (click)="surface.set('signIn')">
            {{ 'ui.admin.theme.preview.signIn' | t }}
          </button>
        </div>
      }
      <div class="th" [style]="vars()">
        @switch (surface()) {
          @case ('form') {
            <div class="th__body th__form">
              <div class="th__field">
                <span>{{ 'ui.builder.preview.sampleName' | t }}</span>
                <div class="th__input" aria-hidden="true">Ravi Kumar</div>
              </div>
              <div class="th__field">
                <span>{{ 'ui.builder.preview.sampleList' | t }}</span>
                <div class="th__input">{{ amount }}</div>
              </div>
              <button appBtn="primary" type="button" tabindex="-1">{{ 'ui.builder.preview.sampleAction' | t }}</button>
            </div>
          }
          @case ('signIn') {
            <div class="th__bar">{{ 'ui.admin.theme.preview.signIn' | t }}</div>
            <div class="th__body th__signin">
              <div class="th__signin-title">Demo Foundation</div>
              <button appBtn="primary" type="button" tabindex="-1">{{ 'ui.auth.signIn' | t }}</button>
            </div>
          }
          @default {
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
                <button appBtn="primary" type="button" tabindex="-1">{{ 'ui.builder.preview.sampleAction' | t }}</button>
                <button appBtn type="button" tabindex="-1">{{ 'ui.common.edit' | t }}</button>
                <span class="th__link">{{ 'ui.builder.preview.sampleLink' | t }}</span>
              </div>
            </div>
          }
        }
      </div>
      <div class="pv__head">
        <h4 class="pv__title">{{ 'ui.builder.contrast.title' | t }}</h4>
        @if (summary(); as s) {
          <p class="pv__summary">{{ 'ui.admin.theme.contrast.summary' | t: { pass: s.pass, total: s.total } }}</p>
        }
      </div>
      <ul class="pv__list">
        @for (p of pairs(); track p.id) {
          <li [class.pv__bad]="!p.contrast || p.contrast.level === 'fail' || p.contrast.level === 'large'">
            <span class="th__swatch" [style.background]="p.foreground"></span><span class="th__swatch" [style.background]="p.background"></span>
            {{ 'ui.builder.contrast.' + p.id | t }}:
            @if (p.contrast; as c) {
              {{ 'ui.builder.contrast.ratio' | t: { ratio: c.ratio } }} ({{ 'ui.builder.contrast.level.' + c.level | t }})
              @if (adminTabs() && (c.level === 'fail' || c.level === 'large')) {
                @if (suggestions()[p.id]; as fix) {
                  <button type="button" class="pv__apply" (click)="applySuggestion.emit(p.id)">{{ 'ui.admin.theme.contrast.applySuggestion' | t }}</button>
                }
                <button type="button" class="pv__fix" (click)="fixPair.emit(p.id)">{{ 'ui.admin.theme.contrast.fix' | t }}</button>
              }
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
  readonly summary = input<{ pass: number; total: number } | null>(null);
  readonly adminTabs = input(false);
  /** Inside the theme screen card: no extra panel border. */
  readonly panel = input(false);
  readonly suggestions = input<Record<string, ThemeSuggestion>>({});
  readonly fixPair = output<string>();
  readonly applySuggestion = output<string>();
  readonly surface = signal<PreviewSurface>('list');
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