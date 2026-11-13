import { Injectable, computed, effect, signal, untracked } from '@angular/core';
import { mayPublishLook } from '../../core/admin/areas';
import { THEME_FIELDS, themeBody, themeDraft, themeNeedsConfirm, themeProblems, type ThemeField } from '../../core/admin/theme-form';
import { failure } from '../../core/admin/roles';
import { t } from '../../core/i18n/i18n';
import type { ThemeTokens } from '../../core/models';
import { AdminBase } from '../admin-store';

/** The organisation theme: the published tokens, a live preview, and one-step publish. */
@Injectable()
export class ThemeStore extends AdminBase {
  readonly fields = THEME_FIELDS;
  readonly values = signal<Record<ThemeField, string>>(themeDraft(null));
  readonly errors = signal<Partial<Record<ThemeField, string>>>({});
  readonly confirm = signal(false);
  readonly saving = signal(false);
  /** True once the published theme has been copied into the draft. Publish stays off until then. */
  readonly ready = signal(false);
  readonly body = computed(() => themeBody(this.values()));
  readonly preview = computed<Record<string, unknown>>(() => ({ ...this.values() }));
  /** Publishing needs `config:publish` or `admin:settings`, as on the server. */
  readonly mayPublish = computed(() => mayPublishLook(this.session.me()?.capabilities));
  readonly canPublish = computed(() => this.mayPublish() && this.ready() && !this.saving() && themeProblems(this.values()).length === 0);
  private filled = false;

  constructor() {
    super();
    void this.i18n.load('builder');
    effect(() => {
      const defs = this.session.defs();
      if (!defs) return;
      untracked(() => {
        if (this.filled) return;
        this.filled = true;
        this.values.set(themeDraft(defs.theme));
        this.ready.set(true);
      });
    });
  }

  set(field: ThemeField, value: string): void {
    this.values.update((current) => ({ ...current, [field]: value }));
    this.errors.update((current) => ({ ...current, [field]: undefined }));
    this.confirm.set(false);
  }

  reset(): void {
    this.values.set(themeDraft(this.session.defs()?.theme));
    this.errors.set({});
    this.confirm.set(false);
    this.ready.set(this.session.defs() !== null);
    this.filled = this.ready();
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
