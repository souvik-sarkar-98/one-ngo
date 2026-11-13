import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Title } from '@angular/platform-browser';
import type { FormValues } from '../core/records/record/forms';
import { t } from '../core/i18n/i18n';
import type { ThemeTokens } from '../core/models';
import { Api, ApiError } from '../services/api';
import { TranslatePipe } from '../services/i18n';
import { CfForm } from '../ui/cf-form';
import { publicControls, type PublicField } from './public-fields';
import { PUBLIC_STYLES, paintPublic } from './public-look';

interface FormView {
  organisation: string;
  theme: Partial<ThemeTokens> | null;
  label: string;
  thanks: string | null;
  fields: PublicField[];
}

interface CataloguePage {
  items: { id: string; values: Record<string, string> }[];
}

/** A public create form. No sign-in. A reference field searches that type's catalogue. */
@Component({
  selector: 'app-public-form-screen',
  imports: [CfForm, TranslatePipe],
  styles: PUBLIC_STYLES,
  template: `
    <header class="pub__band">
      <div class="pub__band-in">
        @if (form(); as page) { <p class="pub__org">{{ page.organisation }}</p> }
      </div>
    </header>
    <main class="pub__main">
      @if (form(); as page) {
        <section class="pub__card">
          <h1 class="pub__title">{{ page.label }}</h1>
          @if (done()) {
            <p class="notice ok" role="status">{{ thanks() || ('ui.public.received' | t) }}</p>
            @if (link()) {
              <p class="pub__foot">{{ 'ui.public.keepLink' | t }}</p>
              <a class="pub__link" [href]="link()">{{ link() }}</a>
            }
          } @else {
            @for (field of references(); track field.key) {
              <div class="pub__ref">
                <label [attr.for]="'ref-' + field.key">{{ field.label }}</label>
                <input [id]="'ref-' + field.key" [value]="query()" (input)="query.set(text($event))" (change)="search(field)" />
                <ul class="pub__hits">
                  @for (hit of hits(); track hit.id) {
                    <li><button type="button" class="app-btn" [attr.aria-pressed]="values()[field.key] === hit.id" (click)="choose(field.key, hit)">{{ hit.text }}</button></li>
                  }
                </ul>
              </div>
            }
            <cf-form [fields]="controls()" [values]="values()" [errors]="errors()" (valuesChange)="values.set($event)" />
            <div class="pub__actions">
              <button type="button" class="app-btn app-btn--primary" [disabled]="busy()" (click)="submit()">{{ 'ui.public.submit' | t }}</button>
            </div>
            @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
          }
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
export class PublicFormScreen {
  private readonly api = inject(Api);
  private readonly title = inject(Title);
  private readonly route = inject(ActivatedRoute);
  readonly code = input.required<string>();
  readonly type = input.required<string>();
  readonly form = signal<FormView | null>(null);
  readonly values = signal<FormValues>({});
  readonly errors = signal<Record<string, string>>({});
  readonly error = signal('');
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly done = signal(false);
  readonly thanks = signal('');
  readonly link = signal('');
  readonly query = signal('');
  readonly hits = signal<{ id: string; text: string }[]>([]);

  readonly references = () => (this.form()?.fields ?? []).filter((field) => field.referenceType);
  readonly controls = () => publicControls(this.form()?.fields ?? []);

  constructor() {
    inject(DestroyRef).onDestroy(() => paintPublic(null));
    effect(() => {
      const code = this.code();
      const type = this.type();
      untracked(() => void this.load(code, type));
    });
  }

  text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  async search(field: PublicField): Promise<void> {
    if (!field.referenceType) return;
    const page = await this.api.get<CataloguePage>(`/api/public/catalogue/${encodeURIComponent(this.code())}/${encodeURIComponent(field.referenceType)}?q=${encodeURIComponent(this.query())}`);
    this.hits.set(page.items.map((item) => ({ id: item.id, text: Object.values(item.values).filter(Boolean).join(' · ') || item.id })));
  }

  choose(key: string, hit: { id: string; text: string }): void {
    this.values.update((values) => ({ ...values, [key]: hit.id }));
    this.query.set(hit.text);
    this.hits.set([]);
  }

  async submit(): Promise<void> {
    const page = this.form();
    if (!page || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.errors.set({});
    try {
      const answer = await this.api.post<{ path?: string; thanks?: string }>(`/api/public/forms/${encodeURIComponent(this.code())}/${encodeURIComponent(this.type())}`, this.values());
      this.link.set(answer.path ?? '');
      this.thanks.set(answer.thanks ?? '');
      this.done.set(true);
    } catch (e) {
      this.show(e);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(code: string, type: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.form.set(null);
    this.done.set(false);
    try {
      const page = await this.api.get<FormView>(`/api/public/forms/${encodeURIComponent(code)}/${encodeURIComponent(type)}`);
      const preset = this.route.snapshot.queryParams;
      const values: FormValues = {};
      for (const field of page.fields) {
        const given = preset[field.key];
        if (typeof given === 'string' && given) values[field.key] = given;
      }
      this.values.set(values);
      this.form.set(page);
      paintPublic(page.theme);
      this.title.setTitle(page.label);
    } catch (e) {
      this.show(e);
    } finally {
      this.loading.set(false);
    }
  }

  private show(e: unknown): void {
    if (e instanceof ApiError) {
      this.error.set(e.message);
      const errors: Record<string, string> = {};
      for (const issue of e.issues) {
        const key = issue.path.replace(/^\//, '');
        if (key) errors[key] = issue.message;
      }
      this.errors.set(errors);
      return;
    }
    this.error.set(t('ui.common.somethingWentWrong'));
  }
}
