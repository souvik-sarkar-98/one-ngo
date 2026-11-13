import { Injectable, Pipe, inject, signal, type PipeTransform } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { currentTranslator, loadText, reloadText, useMessages, type Messages, type Params, type TextArea } from '../core/i18n/i18n';

/** The screen text in use. Templates re-read their text when the language changes, without a reload. */
@Injectable({ providedIn: 'root' })
export class I18n {
  readonly locale = signal(currentTranslator().locale);
  private readonly revision = signal(0);

  /** Uses the messages loaded for `locale`; missing entries fall back to English. Resolves once the shipped text of every loaded area is in that language. */
  use(locale: string, messages: Messages): Promise<void> {
    useMessages(locale, messages);
    document.documentElement.lang = locale;
    this.locale.set(locale);
    this.changed();
    return reloadText().then(
      () => this.changed(),
      () => undefined,
    );
  }

  /** Resolves once the area's screen text is in place. */
  async load(area: TextArea): Promise<void> {
    await loadText(area);
    this.changed();
  }

  t(key: string, params?: Params): string {
    this.revision();
    return currentTranslator().t(key, params);
  }

  private changed(): void {
    this.revision.update((n) => n + 1);
  }
}

/** Holds a route until its area's screen text has loaded, so its screens never show bare keys. */
export const withText =
  (area: TextArea): CanActivateFn =>
  () =>
    inject(I18n)
      .load(area)
      .then(() => true);

/** `{{ 'ui.common.save' | t }}` or `{{ 'ui.records.count' | t: { count: n } }}`. */
@Pipe({ name: 't', pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18n);

  transform(key: string, params?: Params): string {
    return this.i18n.t(key, params);
  }
}
