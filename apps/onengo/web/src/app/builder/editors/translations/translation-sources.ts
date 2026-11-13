import { Injectable, inject, signal } from '@angular/core';
import { httpBuilder } from '../../../core/builder/http-builder';
import { TRANSLATABLE_KINDS, type TranslationSources } from '../../../core/builder/translations';
import { flattenMessages, type Messages } from '../../../core/i18n/i18n';
import { TEXT_FILES } from '../../../core/i18n/i18n-text';
import type { DefinitionKind } from '../../../core/models';
import { Api } from '../../../services/api';

/** The app's shipped screen text in a language, every area of it, loaded only when the grid opens. */
async function shippedText(locale: string): Promise<Messages> {
  const loads = Object.values(TEXT_FILES).flatMap((area) => area[locale] ?? []);
  const files = await Promise.all(loads.map((load) => load().catch(() => ({ default: {} }))));
  return Object.assign({}, ...files.map((f) => flattenMessages(f.default))) as Messages;
}

export interface TranslationDefinition {
  key: string;
  locale: string;
  entries: Record<string, string>;
}

type Body = Record<string, unknown>;

/**
 * What every translations grid reads: the published definitions with text,
 * the shipped screen text per language, and the organisation's translation
 * definitions. Loaded once and kept while the Builder is open.
 */
@Injectable({ providedIn: 'root' })
export class TranslationSourcesStore {
  private readonly gateway = httpBuilder(inject(Api));
  private loading: Promise<void> | null = null;

  readonly definitions = signal<{ kind: DefinitionKind; body: Body }[] | null>(null);
  readonly translations = signal<TranslationDefinition[]>([]);
  readonly shipped = signal<Record<string, Messages>>({});
  readonly failed = signal(false);

  /** Loads everything again, e.g. each time the grid opens, so newly published texts are listed. */
  load(): Promise<void> {
    this.loading ??= this.fetch().finally(() => (this.loading = null));
    return this.loading;
  }

  private async fetch(): Promise<void> {
    this.failed.set(false);
    try {
      const [items] = await Promise.all([this.gateway.catalogue(), this.ensureShipped('en')]);
      const kinds = TRANSLATABLE_KINDS as readonly string[];
      const wanted = items.filter((i) => (kinds.includes(i.kind) && i.publishedVersion !== null) || i.kind === 'translation');
      const details = await Promise.all(wanted.map((i) => this.gateway.detail(i.kind, i.key).catch(() => null)));
      const definitions: { kind: DefinitionKind; body: Body }[] = [];
      const translations: TranslationDefinition[] = [];
      for (const d of details) {
        if (!d) continue;
        if (d.kind === 'translation') {
          const body = (d.draft?.body ?? d.published?.body) as Partial<TranslationDefinition> | undefined;
          if (body?.locale) translations.push({ key: d.key, locale: body.locale, entries: body.entries ?? {} });
        } else if (d.published) definitions.push({ kind: d.kind, body: d.published.body });
      }
      this.definitions.set(definitions);
      this.translations.set(translations);
    } catch {
      this.failed.set(true);
    }
  }

  async ensureShipped(locale: string): Promise<void> {
    if (this.shipped()[locale]) return;
    const messages = await shippedText(locale);
    this.shipped.update((all) => ({ ...all, [locale]: messages }));
  }

  /** The grid's sources for a language; null until loaded. */
  sources(locale: string): TranslationSources | null {
    const definitions = this.definitions();
    const english = this.shipped()['en'];
    const app = this.shipped()[locale];
    return definitions && english && app ? { definitions, english, app } : null;
  }

  /** Keeps a translation the grid has just changed, so shares and the chosen definition follow it. */
  remember(t: TranslationDefinition): void {
    this.translations.update((all) => [...all.filter((x) => x.key !== t.key), t]);
  }
}
