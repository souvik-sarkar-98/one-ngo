import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Btn, PageFrame } from '@onengo/web-kit';
import { ThemePreview } from '../../builder/editors/generic/theme-preview';
import { colourPicker, type ThemeField, type ThemeSuggestion } from '../../core/admin/theme-form';
import { t } from '../../core/i18n/i18n';
import { TranslatePipe } from '../../services/i18n';
import { DialogFocus } from '../../ui/dialog';
import { ScreenHeading } from '../../ui/screen-heading';
import { ThemeStore } from './theme-store';

/** Organisation theme: grouped tokens, live preview, contrast guidance, and publish when ready. */
@Component({
  selector: 'app-admin-theme',
  imports: [Btn, ScreenHeading, ThemePreview, TranslatePipe, PageFrame, DialogFocus],
  providers: [ThemeStore],
  styleUrl: '../admin.css',
  styles: `
    .theme { display: grid; gap: 16px; align-items: start; }
    @media (min-width: 960px) {
      .theme { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    }
    .theme__form {
      display: flex;
      flex-direction: column;
      min-height: 0;
      padding-bottom: 0;
      --theme-footer-inset: 0px;
    }
    .theme__body { flex: 1; min-height: 0; }
    .theme__crow {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 0 0 6px;
      padding: 6px 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--card);
    }
    .theme__crow--warn { border-color: color-mix(in srgb, var(--warn) 55%, var(--line)); background: color-mix(in srgb, var(--warn) 6%, var(--card)); }
    .theme__colour { width: 36px; height: 32px; padding: 0; border: 1px solid var(--line); border-radius: 6px; flex: 0 0 auto; background: var(--card); }
    .theme__crow-label { flex: 1 1 7rem; min-width: 0; font-size: 0.8rem; font-weight: 600; }
    .theme__hex {
      flex: 1 1 6.5rem;
      min-width: 5.5rem;
      font-family: Consolas, 'Courier New', monospace;
      font-size: 0.8rem;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 8px;
      background: var(--card);
    }
    .theme__badge { flex: 0 0 auto; font-size: 0.68rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--ok) 12%, var(--card)); color: var(--ok); white-space: nowrap; }
    .theme__badge--warn { background: color-mix(in srgb, var(--warn) 14%, var(--card)); color: var(--bad); }
    .theme__suggest {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 2px 0 8px;
      font-size: 0.8rem;
      color: var(--muted);
    }
    .theme__suggest .app-btn { font-size: 0.78rem; padding: 0.35rem 0.65rem; }
    .theme__radius { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; }
    .theme__radius label { flex: 1; font-size: 0.8rem; font-weight: 600; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .theme__radius input { width: 100%; font-family: Consolas, 'Courier New', monospace; font-size: 0.8rem; }
    .theme__radius-demo { width: 40px; height: 28px; border: 2px solid var(--brand); flex: 0 0 auto; background: var(--card); }
    .theme__meta { font-size: 0.8rem; color: var(--muted); }
    .theme__palettes { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
    .theme__palette {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font: inherit;
      font-size: 0.8rem;
      padding: 6px 10px;
      border-radius: var(--radius);
      border: 1px solid var(--line);
      background: var(--card);
      cursor: pointer;
    }
    .theme__palette[aria-pressed='true'] { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
    .theme__palette-chip { width: 44px; height: 14px; border-radius: 3px; border: 1px solid var(--line); flex: 0 0 auto; }
    .theme__footer {
      display: flex;
      flex-direction: column;
      gap: 8px;
      position: sticky;
      bottom: var(--theme-footer-inset);
      z-index: 2;
      margin: 0;
      margin-inline: calc(-1 * var(--card-padding));
      padding: var(--card-padding);
      border-top: 1px solid var(--line);
      background: var(--card);
      box-shadow: 0 var(--theme-footer-inset) 0 0 var(--card);
    }
    .theme__footer .theme__meta {
      margin: 0;
    }
    .theme__footer .admin__line--footer {
      margin: 0;
      padding: 0;
      border-top: 0;
    }
    @media (max-width: 759.98px) {
      .theme__form {
        --theme-footer-inset: calc(70px + env(safe-area-inset-bottom, 0px));
      }
    }
    .theme__aside { position: sticky; top: 0; align-self: start; }
    .theme__shade { position: fixed; inset: 0; background: color-mix(in srgb, var(--fg) 35%, transparent); display: grid; place-items: center; z-index: 30; }
    .theme__dialog { width: min(420px, calc(100% - 32px)); margin: 0; }
    .theme__banner-link { font: inherit; color: var(--brand); background: none; border: 0; padding: 0; text-decoration: underline; cursor: pointer; margin-inline-start: 0.35rem; }
  `,
  template: `
    <app-page-frame>
      <app-screen-heading [text]="titleKey | t" />
      @if (store.notice(); as n) {
        <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
      }
      <div class="theme">
        <div class="card theme__form">
          <div class="theme__body">
            @if (store.bannerPair(); as pair) {
              <div class="notice info" role="status">
                {{ 'ui.admin.theme.contrast.banner' | t: { pair: ('ui.builder.contrast.' + pair.id | t) } }}
                <button type="button" class="theme__banner-link" (click)="focusField(store.focusFieldForPair(pair.id))">
                  {{ 'ui.admin.theme.contrast.bannerAction' | t: { field: ('ui.builder.schema.prop.' + store.focusFieldForPair(pair.id) | t) } }}
                </button>
                @if (store.bannerSuggestion(); as fix) {
                  <div class="theme__suggest" style="margin-top: 8px; width: 100%">
                    <span>{{ suggestionLabel(fix) }}</span>
                    <button appBtn="primary" type="button" (click)="store.applyPairSuggestion(pair.id)">
                      {{ 'ui.admin.theme.contrast.applySuggestion' | t }}
                    </button>
                  </div>
                }
              </div>
            }
            @for (group of store.groups; track group.labelKey) {
              <h2 class="admin__caption">{{ group.labelKey | t }}</h2>
              @for (field of group.fields; track field) {
                @if (store.fieldBadge(field); as badge) {
                  @let warn = badge.level === 'fail' || badge.level === 'large';
                  <div class="theme__crow" [class.theme__crow--warn]="warn">
                    <input
                      class="theme__colour"
                      type="color"
                      [attr.aria-label]="'ui.builder.schema.prop.' + field | t"
                      [value]="picker(field)"
                      (input)="store.set(field, $any($event.target).value)"
                    />
                    <label class="theme__crow-label" [attr.for]="'theme-' + field">{{ 'ui.builder.schema.prop.' + field | t }}</label>
                    <input
                      class="theme__hex"
                      [id]="'theme-' + field"
                      type="text"
                      [value]="store.values()[field]"
                      (input)="store.set(field, $any($event.target).value)"
                      [attr.aria-invalid]="!!store.errors()[field]"
                    />
                    <span class="theme__badge" [class.theme__badge--warn]="warn">
                      {{ 'ui.admin.theme.contrast.badge' | t: { ratio: badge.ratio, level: ('ui.builder.contrast.level.' + badge.level | t) } }}
                    </span>
                  </div>
                } @else {
                  <div class="theme__crow">
                    <input
                      class="theme__colour"
                      type="color"
                      [attr.aria-label]="'ui.builder.schema.prop.' + field | t"
                      [value]="picker(field)"
                      (input)="store.set(field, $any($event.target).value)"
                    />
                    <label class="theme__crow-label" [attr.for]="'theme-' + field">{{ 'ui.builder.schema.prop.' + field | t }}</label>
                    <input
                      class="theme__hex"
                      [id]="'theme-' + field"
                      type="text"
                      [value]="store.values()[field]"
                      (input)="store.set(field, $any($event.target).value)"
                      [attr.aria-invalid]="!!store.errors()[field]"
                    />
                  </div>
                }
                @if (store.fieldSuggestion(field); as fix) {
                  <div class="theme__suggest">
                    <span>{{ suggestionLabel(fix) }}</span>
                    <button appBtn="primary" type="button" (click)="store.applyPairSuggestion(fix.pairId)">
                      {{ 'ui.admin.theme.contrast.applySuggestion' | t }}
                    </button>
                  </div>
                }
                @if (store.errors()[field]; as message) {
                  <p class="admin__problem" role="alert">{{ message }}</p>
                }
              }
            }
            <h2 class="admin__caption">{{ 'ui.admin.theme.group.shape' | t }}</h2>
            <div class="theme__radius">
              <label [attr.for]="'theme-radius'">
                {{ 'ui.builder.schema.prop.radius' | t }}
                <input id="theme-radius" type="text" [value]="store.values().radius" (input)="store.set('radius', $any($event.target).value)" [attr.aria-invalid]="!!store.errors().radius" />
              </label>
              <span class="theme__radius-demo" [style.border-radius]="store.values().radius" aria-hidden="true"></span>
            </div>
            @if (store.errors().radius; as message) {
              <p class="admin__problem" role="alert">{{ message }}</p>
            }
            <h2 class="admin__caption">{{ 'ui.admin.theme.quickStart' | t }}</h2>
            <div class="theme__palettes">
              @for (palette of store.palettes; track palette.id) {
                <button type="button" class="theme__palette" [attr.aria-pressed]="store.activePalette() === palette.id" (click)="store.applyPalette(palette)">
                  <span
                    class="theme__palette-chip"
                    [style.background]="'linear-gradient(90deg,' + palette.tokens.brand + ' 0 33%,' + palette.tokens.background + ' 33% 66%,' + palette.tokens.text + ' 66%)'"
                    aria-hidden="true"
                  ></span>
                  {{ palette.labelKey | t }}
                </button>
              }
            </div>
          </div>
          <div class="theme__footer">
            @if (store.dirty()) {
              <p class="theme__meta">{{ 'ui.admin.theme.unsaved' | t }}</p>
            }
            <div class="admin__line admin__line--footer">
              <button appBtn type="button" (click)="store.reset()">{{ 'ui.admin.theme.reset' | t }}</button>
              @if (store.dirty()) {
                <button appBtn type="button" (click)="store.discard()">{{ 'ui.admin.theme.discard' | t }}</button>
              }
              <span class="admin__grow"></span>
              <button appBtn="primary" type="button" [disabled]="!store.canPublish()" (click)="store.publish()">{{ 'ui.admin.theme.publish' | t }}</button>
            </div>
          </div>
        </div>
        <div class="card theme__aside">
          <app-theme-preview
            [body]="store.preview()"
            [exact]="true"
            [adminTabs]="true"
            [panel]="true"
            [summary]="store.contrastSummary()"
            [suggestions]="store.pairSuggestions()"
            (fixPair)="focusField(store.focusFieldForPair($event))"
            (applySuggestion)="store.applyPairSuggestion($event)"
          />
        </div>
      </div>
      @if (store.confirm()) {
        <div class="theme__shade" data-dialog-shade>
          <div class="card theme__dialog" appDialog role="dialog" aria-labelledby="theme-confirm-title" (escape)="store.confirm.set(false)">
            <h2 id="theme-confirm-title">{{ 'ui.admin.theme.confirmTitle' | t }}</h2>
            <p>{{ 'ui.admin.theme.confirmBody' | t }}</p>
            <div class="admin__line">
              <button appBtn type="button" (click)="store.confirm.set(false)">{{ 'ui.admin.theme.chooseAnother' | t }}</button>
              <button appBtn="primary" type="button" [disabled]="!store.canPublish()" (click)="store.publish()">{{ 'ui.admin.theme.publishAnyway' | t }}</button>
            </div>
          </div>
        </div>
      }
    </app-page-frame>
  `,
})
export class ThemeScreen {
  readonly store = inject(ThemeStore);
  readonly titleKey = inject(Router).url.includes('/builder/') ? 'ui.builder.look.theme' : 'ui.crumbs.admin.theme';

  picker(field: ThemeField): string {
    return colourPicker(field, this.store.values()[field]);
  }

  focusField(field: ThemeField): void {
    document.getElementById(`theme-${field}`)?.focus();
  }

  suggestionLabel(fix: ThemeSuggestion): string {
    return t('ui.admin.theme.contrast.suggestion', {
      hex: fix.hex,
      ratio: fix.ratio,
      field: t(`ui.builder.schema.prop.${fix.field}`),
    });
  }
}