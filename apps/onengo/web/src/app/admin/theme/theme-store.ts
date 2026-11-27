import { Injectable, computed, effect, signal, untracked } from '@angular/core';
import { draftPairs } from '../../core/builder/contrast';
import { mayPublishLook } from '../../core/admin/areas';
import {
  PAIR_FOCUS_FIELD,
  THEME_GROUPS,
  THEME_PALETTES,
  contrastAttention,
  fieldContrastBadge,
  suggestForField,
  suggestForPair,
  themeBody,
  themeDraft,
  themeNeedsConfirm,
  themeProblems,
  themeValuesEqual,
  type ThemeField,
  type ThemePalette,
  type ThemeSuggestion,
} from '../../core/admin/theme-form';
import { failure } from '../../core/admin/roles';
import { t } from '../../core/i18n/i18n';
import type { ThemeTokens } from '../../core/models';
import { AdminBase } from '../admin-store';

/** The organisation theme: the published tokens, a live preview, and one-step publish. */
@Injectable()
export class ThemeStore extends AdminBase {
  readonly groups = THEME_GROUPS;
  readonly palettes = THEME_PALETTES;
  /** The screen's heading: the Builder's name for it under /builder, Administration's otherwise. */
  readonly titleKey = this.router.url.includes('/builder/') ? 'ui.builder.look.theme' : 'ui.crumbs.admin.theme';
  readonly values = signal<Record<ThemeField, string>>(themeDraft(null));
  readonly errors = signal<Partial<Record<ThemeField, string>>>({});
  readonly confirm = signal(false);
  readonly saving = signal(false);
  readonly activePalette = signal<string | null>(null);
  /** True once the published theme has been copied into the draft. Publish stays off until then. */
  readonly ready = signal(false);
  readonly published = computed(() => themeDraft(this.session.defs()?.theme));
  readonly dirty = computed(() => this.ready() && !themeValuesEqual(this.values(), this.published()));
  readonly body = computed(() => themeBody(this.values()));
  readonly preview = computed<Record<string, unknown>>(() => ({ ...this.values() }));
  readonly pairs = computed(() => draftPairs(this.values()));
  readonly attentionPairs = computed(() => contrastAttention(this.pairs()));
  readonly bannerPair = computed(() => this.attentionPairs()[0] ?? null);
  readonly pairSuggestions = computed(() => {
    const out: Record<string, ThemeSuggestion> = {};
    for (const pair of this.attentionPairs()) {
      const fix = suggestForPair(pair);
      if (fix) out[pair.id] = fix;
    }
    return out;
  });
  readonly contrastSummary = computed(() => {
    const pairs = this.pairs();
    const pass = pairs.filter((pair) => pair.contrast && pair.contrast.level !== 'fail' && pair.contrast.level !== 'large').length;
    return { pass, total: pairs.length };
  });
  /** Publishing needs `config:publish` or `admin:settings`, as on the server. */
  readonly mayPublish = computed(() => mayPublishLook(this.session.me()?.capabilities));
  readonly canPublish = computed(() => this.mayPublish() && this.ready() && !this.saving() && themeProblems(this.values()).length === 0);
  private filled = false;

  constructor() {
    super();
    void this.i18n.load('builder');
    void this.i18n.load('admin');
    effect(() => {
      const defs = this.session.defs();
      if (!defs) return;
      untracked(() => {
        if (this.filled) return;
        this.filled = true;
        this.values.set(themeDraft(defs.theme));
        this.ready.set(true);
        this.syncPalette();
      });
    });
  }

  fieldBadge(field: ThemeField) {
    return fieldContrastBadge(field, this.values());
  }

  focusFieldForPair(pairId: string): ThemeField {
    return PAIR_FOCUS_FIELD[pairId] ?? 'text';
  }

  fieldSuggestion(field: ThemeField) {
    return suggestForField(field, this.values());
  }

  pairSuggestion(pairId: string) {
    const pair = this.pairs().find((item) => item.id === pairId);
    return pair ? suggestForPair(pair) : null;
  }

  bannerSuggestion() {
    const pair = this.bannerPair();
    return pair ? suggestForPair(pair) : null;
  }

  applySuggestion(field: ThemeField, hex: string): void {
    this.set(field, hex);
  }

  applyPairSuggestion(pairId: string): void {
    const fix = this.pairSuggestion(pairId);
    if (fix) this.applySuggestion(fix.field, fix.hex);
  }

  set(field: ThemeField, value: string): void {
    this.values.update((current) => ({ ...current, [field]: value }));
    this.errors.update((current) => ({ ...current, [field]: undefined }));
    this.confirm.set(false);
    this.syncPalette();
  }

  applyPalette(palette: ThemePalette): void {
    this.values.set({ ...palette.tokens });
    this.errors.set({});
    this.confirm.set(false);
    this.activePalette.set(palette.id);
  }

  discard(): void {
    this.reset();
  }

  reset(): void {
    this.values.set(themeDraft(this.session.defs()?.theme));
    this.errors.set({});
    this.confirm.set(false);
    this.ready.set(this.session.defs() !== null);
    this.filled = this.ready();
    this.syncPalette();
  }

  publish(): void {
    if (!this.ready() || !this.mayPublish()) return;
    const bad = themeProblems(this.values());
    if (bad.length) {
      this.errors.set(Object.fromEntries(bad.map((field) => [field, t(field === 'radius' ? 'ui.admin.theme.invalidRadius' : 'ui.admin.theme.invalidColour')])));
      this.confirm.set(false);
      return;
    }
    const body = this.body();
    this.errors.set({});
    if (themeNeedsConfirm(body) && !this.confirm()) {
      this.confirm.set(true);
      return;
    }
    void this.send(body);
  }

  private syncPalette(): void {
    const current = this.values();
    const match = this.palettes.find((palette) => themeValuesEqual(current, palette.tokens));
    this.activePalette.set(match?.id ?? null);
  }

  private async send(body: ThemeTokens): Promise<void> {
    this.saving.set(true);
    try {
      await this.gateway.saveTheme(body);
      await this.session.reload();
      this.reset();
      this.show({ level: 'success', message: t('ui.admin.theme.published') });
    } catch (e) {
      this.show({ level: 'error', message: failure(e) });
    } finally {
      this.saving.set(false);
    }
  }
}