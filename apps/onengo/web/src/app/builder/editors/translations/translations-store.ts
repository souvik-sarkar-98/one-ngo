import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';
import { httpBuilder } from '../../../core/builder/http-builder';
import {
  newTranslationKey,
  parseTranslationsAddress,
  translatedShare,
  translationFor,
  translationRows,
  translationsParams,
  type TranslationFilter,
  type TranslationsAddress,
} from '../../../core/builder/translations';
import { LOCALES, t } from '../../../core/i18n/i18n';
import { languageName } from '../../../core/i18n/languages';
import { asGatewayError } from '../../../core/records/gateway/gateway';
import { Api } from '../../../services/api';
import { I18n } from '../../../services/i18n';
import { ScreenMeta } from '../../../services/screen-meta';
import { Session } from '../../../services/session';
import { Viewport } from '../../../ui/viewport';
import { TranslationSourcesStore } from './translation-sources';

/** Where the grid's filter lives: in the address on the translations screen, in the editor otherwise. */
export interface GridFilter {
  readonly filter: () => TranslationFilter;
  setFilter(change: Partial<TranslationFilter>): void;
}

/**
 * The translations screen (`/builder/translations?locale=hi&missing=true&q=…`):
 * the languages with how much is translated, the grid's filter in the
 * address, and the language's translation definition, created with the
 * first entry typed when it has none yet.
 */
@Injectable()
export class TranslationsStore implements GridFilter {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(Session);
  private readonly i18n = inject(I18n);
  private readonly meta = inject(ScreenMeta);
  private readonly gateway = httpBuilder(inject(Api));
  readonly sources = inject(TranslationSourcesStore);

  readonly address = toSignal(this.route.queryParamMap.pipe(map((p) => parseTranslationsAddress((n) => p.get(n)))), {
    initialValue: parseTranslationsAddress((n) => this.route.snapshot.queryParamMap.get(n)),
  });
  readonly narrow = inject(Viewport).narrow;
  readonly canEdit = computed(() => !this.narrow() && !!this.session.me()?.capabilities.publish);
  readonly locales = computed(() => {
    const own = this.sources.translations().map((x) => x.locale);
    return [...new Set([...LOCALES.filter((l) => l !== 'en'), ...own])];
  });
  readonly locale = computed(() => {
    const asked = this.address().locale;
    if (asked) return asked;
    const mine = this.i18n.locale();
    return mine !== 'en' ? mine : this.locales()[0]!;
  });
  readonly filter = computed<TranslationFilter>(() => {
    const { locale: _, ...f } = this.address();
    return f;
  });
  /** The translation definition of the language; null until the first entry is typed. */
  readonly key = computed(() => translationFor(this.locale(), this.sources.translations()));
  readonly chips = computed(() => {
    this.i18n.locale();
    return this.locales().map((code) => {
      const sources = this.sources.sources(code);
      const entries = this.sources.translations().find((x) => x.locale === code)?.entries ?? {};
      const share = sources ? translatedShare(translationRows(sources, entries)) : null;
      const name = languageName(code);
      return { id: code, label: share === null ? name : t('ui.builder.translations.chip', { name, share }) };
    });
  });
  readonly starting = signal(false);
  readonly error = signal('');

  constructor() {
    void this.sources.load();
    effect(() => {
      const codes = this.locales();
      untracked(() => codes.forEach((c) => void this.sources.ensureShipped(c)));
    });
    effect(() => {
      const name = languageName(this.locale());
      const labels = this.meta.crumbLabels();
      if (labels['locale'] !== name) untracked(() => this.meta.crumbLabels.set({ ...labels, locale: name }));
    });
    inject(DestroyRef).onDestroy(() => this.meta.clear());
  }

  chooseLocale(locale: string): void {
    this.navigate({ locale });
  }

  setFilter(change: Partial<TranslationFilter>): void {
    this.navigate(change);
  }

  /** Saves the language's first translation draft with the entry just typed; the editor takes over from there. */
  async start(path: string, value: string): Promise<void> {
    if (this.starting() || !value.trim()) return;
    const locale = this.locale();
    this.starting.set(true);
    this.error.set('');
    try {
      const taken = (await this.gateway.catalogue()).filter((i) => i.kind === 'translation').map((i) => i.key);
      const body = { key: newTranslationKey(locale, taken), locale, entries: { [path]: value } };
      await this.gateway.saveDraft('translation', body.key, body);
      this.sources.remember(body);
    } catch (e) {
      this.error.set(asGatewayError(e, t('ui.builder.saveFailed')).message);
    } finally {
      this.starting.set(false);
    }
  }

  private navigate(change: Partial<TranslationsAddress>): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: translationsParams(change), queryParamsHandling: 'merge', replaceUrl: true });
  }
}
