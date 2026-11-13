import { currentTranslator, formatNumber, intlLocale, t } from '../i18n/i18n';
import type { FormValues } from '../records/record/forms';
import type { OrganisationSettings, SettingsChange } from './admin';

const GB = 1024 ** 3;

/** A size in bytes as people read it: MB below a gigabyte, GB above. */
export function sizeText(bytes: number): string {
  if (bytes >= GB) return `${formatNumber(Math.round((bytes / GB) * 10) / 10)} GB`;
  return `${formatNumber(Math.round(bytes / 1024 ** 2))} MB`;
}

/** Storage use against the quota, for the bar: 0 to 100. */
export function storagePercent(s: OrganisationSettings['storage']): number {
  return s.quotaBytes > 0 ? Math.min(100, Math.round((s.usedBytes / s.quotaBytes) * 100)) : 0;
}

/** The Identity fields: display name, legal name and default language. */
export function identityValues(s: OrganisationSettings): FormValues {
  return {
    name: s.name,
    legalName: s.legalName ?? '',
    defaultLanguage: s.defaultLanguage,
  };
}

/** The Settings fields: storage quota, API requests per minute, browser origins and the financial year start. */
export function settingsValues(s: OrganisationSettings): FormValues {
  return {
    quotaGb: String(Math.round((s.storage.quotaBytes / GB) * 100) / 100),
    apiRequestsPerMinute: String(s.apiRequestsPerMinute),
    corsOrigins: (s.corsOrigins ?? []).join('\n'),
    financialYearStartMonth: String(s.financialYearStartMonth),
  };
}

/** January to December in the app language, as options keyed 1 to 12. */
export function monthOptions(): { key: string; label: string }[] {
  const names = new Intl.DateTimeFormat(intlLocale(currentTranslator().locale), { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, i) => ({ key: String(i + 1), label: names.format(new Date(Date.UTC(2026, i, 1))) }));
}

/** What Save sends from Identity: only the names and language that changed; or the problems, by field. */
export function identityChange(s: OrganisationSettings, v: FormValues): { change: SettingsChange } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const change: SettingsChange = {};
  const name = String(v['name'] ?? '').trim();
  if (!name) errors['name'] = t('ui.records.required', { field: t('ui.admin.settings.name') });
  else if (name !== s.name) change.name = name;
  const legalName = String(v['legalName'] ?? '').trim().replace(/\s+/g, ' ');
  if (!legalName) errors['legalName'] = t('ui.records.required', { field: t('ui.admin.organisation.legalName') });
  else if (legalName.length > 200) errors['legalName'] = t('ui.admin.organisation.tooLong', { max: 200 });
  else if (legalName !== (s.legalName ?? '')) change.legalName = legalName;
  const lang = String(v['defaultLanguage'] ?? '');
  if (lang && lang !== s.defaultLanguage) change.defaultLanguage = lang;
  return Object.keys(errors).length ? { errors } : { change };
}

/** What Save sends from Settings: only the values that changed; or the problems, by field. */
export function settingsChange(s: OrganisationSettings, v: FormValues): { change: SettingsChange } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const change: SettingsChange = {};
  const gb = Number(String(v['quotaGb'] ?? '').trim());
  if (!Number.isFinite(gb) || gb < 0 || String(v['quotaGb'] ?? '').trim() === '') errors['quotaGb'] = t('ui.admin.settings.number');
  else if (Math.abs(gb - s.storage.quotaBytes / GB) >= 0.005) change.storageQuotaBytes = Math.round(gb * GB);
  const rate = Number(String(v['apiRequestsPerMinute'] ?? '').trim());
  if (!Number.isInteger(rate) || rate < 1) errors['apiRequestsPerMinute'] = t('ui.admin.settings.number');
  else if (rate !== s.apiRequestsPerMinute) change.apiRequestsPerMinute = rate;
  const origins = originsOf(String(v['corsOrigins'] ?? ''));
  if ('error' in origins) errors['corsOrigins'] = origins.error;
  else if (origins.list.join('\n') !== (s.corsOrigins ?? []).join('\n')) change.corsOrigins = origins.list;
  const month = Number(v['financialYearStartMonth'] ?? s.financialYearStartMonth);
  if (!s.financialYearFixed && Number.isInteger(month) && month >= 1 && month <= 12 && month !== s.financialYearStartMonth) change.financialYearStartMonth = month;
  return Object.keys(errors).length ? { errors } : { change };
}

/** One exact http or https origin per line, at most ten. */
function originsOf(text: string): { list: string[] } | { error: string } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 10) return { error: t('ui.admin.settings.corsInvalid') };
  const list: string[] = [];
  for (const line of lines) {
    try {
      const url = new URL(line);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== line) return { error: t('ui.admin.settings.corsInvalid') };
    } catch {
      return { error: t('ui.admin.settings.corsInvalid') };
    }
    if (!list.includes(line)) list.push(line);
  }
  return { list };
}
