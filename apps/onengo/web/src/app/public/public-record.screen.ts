import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import type { FormValues } from '../core/records/record/forms';
import { t } from '../core/i18n/i18n';
import type { ThemeTokens } from '../core/models';
import { Api, ApiError } from '../services/api';
import { TranslatePipe } from '../services/i18n';
import { CfForm } from '../ui/cf-form';
import { publicControls, type PublicField } from './public-fields';
import { PUBLIC_STYLES, paintPublic } from './public-look';

interface Submission {
  theme: Partial<ThemeTokens> | null;
  label: string;
  number: string | null;
  statusLabel: string | null;
  version: number;
  edit: boolean;
  delete: boolean;
  fields: PublicField[];
  values?: Record<string, unknown>;
  display: Record<string, string>;
}

/** One submission opened with its secret link. Edit and delete render only when the response allows them. */
@Component({
  selector: 'app-public-record-screen',
  imports: [CfForm, TranslatePipe],
  styles: PUBLIC_STYLES,
  template: `
    <header class="pub__band">
      <div class="pub__band-in">
        @if (page(); as submission) { <p class="pub__org">{{ submission.label }}</p> }
      </div>
    </header>
    <main class="pub__main">
      @if (page(); as submission) {
        <section class="pub__card">
          @if (submission.number) { <h1 class="pub__title">{{ submission.number }}</h1> }
          @if (submission.statusLabel) { <p class="pub__meta">{{ submission.statusLabel }}</p> }
          @if (editing()) {
            <cf-form [fields]="controls()" [values]="values()" [errors]="errors()" (valuesChange)="values.set($event)" />
            <div class="pub__actions">
              <button type="button" class="app-btn app-btn--primary" [disabled]="busy()" (click)="save()">{{ 'ui.public.save' | t }}</button>
              <button type="button" class="app-btn" (click)="editing.set(false)">{{ 'ui.common.cancel' | t }}</button>
            </div>
          } @else {
            <dl class="pub__dl">
              @for (field of submission.fields; track field.key) {
                <dt>{{ field.label }}</dt>
                <dd>{{ submission.display[field.key] }}</dd>
              }
            </dl>
            @if (submission.edit || submission.delete) {
              <div class="pub__actions">
                @if (submission.edit) { <button type="button" class="app-btn app-btn--primary" (click)="editing.set(true)">{{ 'ui.common.edit' | t }}</button> }
                @if (submission.delete) { <button type="button" class="app-btn danger" [disabled]="busy()" (click)="remove()">{{ 'ui.public.delete' | t }}</button> }
              </div>
            }
          }
          @if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
        </section>
      } @else if (loading()) {
        <p class="pub__state" role="status">{{ 'ui.public.loading' | t }}</p>
      } @else if (deleted()) {
        <section class="pub__card">
          <p class="notice ok" role="status">{{ 'ui.public.deleted' | t }}</p>
        </section>
      } @else if (error()) {
        <section class="pub__card">
          <p class="notice error" role="alert">{{ error() }}</p>
        </section>
      }
    </main>
  `,
})
export class PublicRecordScreen {
  private readonly api = inject(Api);
  private readonly title = inject(Title);
  readonly token = input.required<string>();
  readonly page = signal<Submission | null>(null);
  readonly values = signal<FormValues>({});
  readonly errors = signal<Record<string, string>>({});
  readonly editing = signal(false);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly deleted = signal(false);

  readonly controls = () => publicControls(this.page()?.fields ?? []);

  constructor() {
    inject(DestroyRef).onDestroy(() => paintPublic(null));
    effect(() => {
      const token = this.token();
      untracked(() => void this.load(token));
    });
  }

  async save(): Promise<void> {
    const submission = this.page();
    if (!submission || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const next = await this.api.patch<Submission>(`/api/public/records/${encodeURIComponent(this.token())}`, { values: this.values(), expectedVersion: submission.version });
      this.apply(next);
      this.editing.set(false);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : t('ui.common.somethingWentWrong'));
    } finally {
      this.busy.set(false);
    }
  }

  async remove(): Promise<void> {
    const submission = this.page();
    if (!submission || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.delete(`/api/public/records/${encodeURIComponent(this.token())}?version=${submission.version}`);
      this.page.set(null);
      paintPublic(null);
      this.deleted.set(true);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : t('ui.common.somethingWentWrong'));
    } finally {
      this.busy.set(false);
    }
  }

  private async load(token: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.deleted.set(false);
    try {
      this.apply(await this.api.get<Submission>(`/api/public/records/${encodeURIComponent(token)}`));
    } catch (e) {
      this.page.set(null);
      this.error.set(e instanceof ApiError ? e.message : t('ui.common.somethingWentWrong'));
    } finally {
      this.loading.set(false);
    }
  }

  private apply(submission: Submission): void {
    this.page.set(submission);
    paintPublic(submission.theme);
    const values: FormValues = {};
    for (const [key, value] of Object.entries(submission.values ?? {})) {
      if (typeof value === 'string' || typeof value === 'boolean' || value === null || Array.isArray(value)) values[key] = value as FormValues[string];
      else if (typeof value === 'number') values[key] = String(value);
      else if (value && typeof value === 'object') values[key] = value as FormValues[string];
    }
    this.values.set(values);
    this.title.setTitle(submission.label);
  }
}
