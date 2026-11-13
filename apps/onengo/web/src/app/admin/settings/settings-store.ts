import { Injectable, computed, inject, signal } from '@angular/core';
import type { OrganisationSettings } from '../../core/admin/admin';
import { failure } from '../../core/admin/roles';
import { identityChange, identityValues, monthOptions, settingsChange, settingsValues, sizeText, storagePercent } from '../../core/admin/settings';
import { t } from '../../core/i18n/i18n';
import { languageName } from '../../core/i18n/languages';
import type { FormValues } from '../../core/records/record/forms';
import { Organisation } from '../../services/organisation';
import type { CfFieldDef } from '../../ui/cf-types';
import { AdminBase } from '../admin-store';
import { enterPlaceholder } from './organisation-store';

/**
 * Organisation settings. The names and default language are on Identity; storage use and quota, API requests per minute and the financial year start are on Settings. Every change is audited.
 */
@Injectable()
export class SettingsStore extends AdminBase {
  private readonly organisation = inject(Organisation);
  readonly settings = signal<OrganisationSettings | null>(null);
  readonly values = signal<FormValues>({});
  readonly errors = signal<Record<string, string>>({});
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly used = computed(() => {
    const s = this.settings();
    return s ? t('ui.admin.settings.used', { used: sizeText(s.storage.usedBytes), quota: sizeText(s.storage.quotaBytes) }) : '';
  });
  readonly percent = computed(() => (this.settings() ? storagePercent(this.settings()!.storage) : 0));
  readonly general = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    const s = this.settings();
    return [
      { key: 'name', label: t('ui.admin.settings.name'), type: 'text', required: true, readOnly: false, options: [], maxLength: 200, placeholder: enterPlaceholder('ui.admin.settings.name') },
      {
        key: 'legalName',
        label: t('ui.admin.organisation.legalName'),
        type: 'text',
        required: true,
        readOnly: false,
        options: [],
        maxLength: 200,
        hint: t('ui.admin.organisation.legalNameHint'),
        placeholder: enterPlaceholder('ui.admin.organisation.legalName'),
      },
      {
        key: 'defaultLanguage',
        label: t('ui.admin.settings.language'),
        type: 'select',
        required: true,
        readOnly: false,
        options: (s?.languages ?? []).map((l) => ({ key: l, label: languageName(l) })),
        hint: t('ui.admin.settings.languageHint'),
        placeholder: enterPlaceholder('ui.admin.settings.language'),
      },
    ];
  });
  readonly storage = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    return [{ key: 'quotaGb', label: t('ui.admin.settings.quota'), type: 'number', required: true, readOnly: false, options: [], placeholder: enterPlaceholder('ui.admin.settings.quota') }];
  });
  readonly api = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    return [
      { key: 'apiRequestsPerMinute', label: t('ui.admin.settings.apiRate'), type: 'number', required: true, readOnly: false, options: [], placeholder: enterPlaceholder('ui.admin.settings.apiRate') },
      { key: 'corsOrigins', label: t('ui.admin.settings.cors'), type: 'textarea', required: false, readOnly: false, options: [], hint: t('ui.admin.settings.corsHint') },
    ];
  });
  readonly finance = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    const fixed = this.settings()?.financialYearFixed ?? false;
    return [
      {
        key: 'financialYearStartMonth',
        label: t('ui.admin.settings.fyStart'),
        type: 'select',
        required: true,
        readOnly: fixed,
        options: monthOptions(),
        hint: t(fixed ? 'ui.admin.settings.fyStartFixed' : 'ui.admin.settings.fyStartHint'),
        placeholder: enterPlaceholder('ui.admin.settings.fyStart'),
      },
    ];
  });

  constructor() {
    super();
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.use(await this.gateway.settings());
      this.error.set('');
    } catch (e) {
      this.error.set(failure(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Saves one screen's fields: Identity's names and language, or Settings' storage, API and financial year. */
  async save(part: 'identity' | 'settings'): Promise<void> {
    const s = this.settings();
    if (!s || this.saving()) return;
    const out = part === 'identity' ? identityChange(s, this.values()) : settingsChange(s, this.values());
    if ('errors' in out) return this.errors.set(out.errors);
    this.errors.set({});
    if (!Object.keys(out.change).length) return;
    this.saving.set(true);
    try {
      this.use(await this.gateway.saveSettings(out.change));
      if (out.change.name) void this.organisation.refresh();
      this.show({ ok: true, message: t('ui.admin.settings.saved') });
    } catch (e) {
      this.show({ ok: false, message: failure(e) });
    } finally {
      this.saving.set(false);
    }
  }

  private use(s: OrganisationSettings): void {
    this.settings.set(s);
    this.values.set({ ...identityValues(s), ...settingsValues(s) });
  }
}
