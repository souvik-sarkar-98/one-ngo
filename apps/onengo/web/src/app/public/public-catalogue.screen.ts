import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { t } from '../core/i18n/i18n';
import type { ThemeTokens } from '../core/models';
import { Api, ApiError } from '../services/api';
import { TranslatePipe } from '../services/i18n';
import { PUBLIC_STYLES, paintPublic } from './public-look';

interface CataloguePage {
  organisation: string;
  theme: Partial<ThemeTokens> | null;
  label: string;
  fields: { key: string; label: string }[];
  items: { id: string; values: Record<string, string>; requestPath: string | null }[];
  more: boolean;
}

/** Search of a public catalogue. No sign-in. A row opens the request form only when one is configured. */
@Component({
  selector: 'app-public-catalogue-screen',
  imports: [TranslatePipe],
  styles: PUBLIC_STYLES,
  template: `
    <header class="pub__band">
      <div class="pub__band-in">
        @if (page(); as catalogue) { <p class="pub__org">{{ catalogue.organisation }}</p> }
      </div>
    </header>
    <main class="pub__main">
      @if (page(); as catalogue) {
        <section class="pub__card">
          <h1 class="pub__title">{{ catalogue.label }}</h1>
          <form class="pub__search" role="search" (submit)="$event.preventDefault(); search()">
            <input type="search" [value]="query()" (input)="query.set(text($event))" [attr.aria-label]="'ui.public.search' | t" />
            <button type="submit" class="app-btn app-btn--primary">{{ 'ui.public.search' | t }}</button>
          </form>
          @if (!catalogue.items.length) {
            <p class="pub__lede">{{ 'ui.public.none' | t }}</p>
          }
          <ul class="pub__rows">
            @for (item of catalogue.items; track item.id) {
              <li class="pub__row">
                <div class="pub__fields">
                  @for (field of catalogue.fields; track field.key) {
                    <p class="pub__field"><span class="pub__field-label">{{ field.label }}:</span>{{ item.values[field.key] }}</p>
                  }
                </div>
                @if (item.requestPath) { <a class="app-btn app-btn--primary" [href]="item.requestPath">{{ 'ui.public.request' | t }}</a> }
              </li>
            }
          </ul>
          @if (catalogue.more) { <p class="pub__foot">{{ 'ui.public.more' | t }}</p> }
        </section>
      } @else if (loading()) {
        <p class="pub__state" role="status">{{ 'ui.public.loading' | t }}</p>
      } @else if (error()) {
        <section class="pub__card">
          <p class="notice error" role="alert">{{ error() }}</p>
        </section>
      }
    </main>
  `,
})
export class PublicCatalogueScreen {
  private readonly api = inject(Api);
  private readonly title = inject(Title);
  readonly code = input.required<string>();
  readonly type = input.required<string>();
  readonly query = signal('');
  readonly page = signal<CataloguePage | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  constructor() {
    inject(DestroyRef).onDestroy(() => paintPublic(null));
    effect(() => {
      const code = this.code();
      const type = this.type();
      untracked(() => void this.load(code, type, ''));
    });
  }

  text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  search(): void {
    void this.load(this.code(), this.type(), this.query());
  }

  private async load(code: string, type: string, q: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const page = await this.api.get<CataloguePage>(`/api/public/catalogue/${encodeURIComponent(code)}/${encodeURIComponent(type)}?q=${encodeURIComponent(q)}`);
      this.page.set(page);
      paintPublic(page.theme);
      this.title.setTitle(page.label);
    } catch (e) {
      this.page.set(null);
      this.error.set(e instanceof ApiError ? e.message : t('ui.common.somethingWentWrong'));
    } finally {
      this.loading.set(false);
    }
  }
}
