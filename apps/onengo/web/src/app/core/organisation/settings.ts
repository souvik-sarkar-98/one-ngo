import { intlLocale, t } from '../i18n/i18n';
import type { FormValues } from '../records/record/forms';
import { asGatewayError } from '../records/gateway/gateway';
import { LOGO_MAX_BYTES, LOGO_TYPES, SIGNATURE_MAX_BYTES, type OrganisationProfileRequest, type OrganisationView, type Registration, type RegistrationRequest, type SetupItem } from './organisation';

const text = (v: FormValues, key: string) => String(v[key] ?? '').trim();
const orNull = (s: string) => s || null;

/** The profile form: contact, structured address and time zone. The names and language are on Identity. */
export function profileValues(o: OrganisationView): FormValues {
  return {
    email: o.contact.email ?? '',
    phone: o.contact.phone ?? '',
    website: o.contact.website ?? '',
    line1: o.address?.line1 ?? '',
    line2: o.address?.line2 ?? '',
    city: o.address?.city ?? '',
    state: o.address?.state ?? '',
    postalCode: o.address?.postalCode ?? '',
    country: o.address?.country ?? '',
    timezone: o.timezone ?? '',
  };
}

const ADDRESS = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const;
const REQUIRED_ADDRESS = ['line1', 'city', 'postalCode', 'country'] as const;
const CONTACT = ['email', 'phone', 'website'] as const;

const required = (labelKey: string) => t('ui.records.required', { field: t(labelKey) });

/**
 * What Save sends: a profile change with only the contact fields that changed,
 * the whole address when any part of it changed, and the time zone when it
 * changed. Or the problems, by field.
 */
export function profileChange(o: OrganisationView, v: FormValues): { profile: OrganisationProfileRequest } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: { profile: OrganisationProfileRequest } = { profile: {} };

  const contact: NonNullable<OrganisationProfileRequest['contact']> = {};
  for (const k of CONTACT) if (text(v, k) !== (o.contact[k] ?? '')) contact[k] = text(v, k);
  if (Object.keys(contact).length) out.profile.contact = contact;

  const address = Object.fromEntries(ADDRESS.map((k) => [k, k === 'country' ? text(v, k).toUpperCase() : text(v, k)])) as Record<(typeof ADDRESS)[number], string>;
  const was = o.address;
  const changed = ADDRESS.some((k) => address[k] !== (was?.[k] ?? ''));
  if (changed) {
    const missing = REQUIRED_ADDRESS.filter((k) => !address[k]);
    for (const k of missing) errors[k] = required(`ui.admin.organisation.${k}`);
    if (!missing.includes('country') && !/^[A-Z]{2}$/.test(address.country)) errors['country'] = t('ui.admin.organisation.countryInvalid');
    out.profile.address = {
      line1: address.line1,
      city: address.city,
      postalCode: address.postalCode,
      country: address.country,
      ...(address.line2 ? { line2: address.line2 } : {}),
      ...(address.state ? { state: address.state } : {}),
    };
  }
  const timezone = text(v, 'timezone');
  if (timezone !== (o.timezone ?? '')) {
    if (!timezone) errors['timezone'] = required('ui.admin.organisation.timezone');
    else out.profile.timezone = timezone;
  }
  return Object.keys(errors).length ? { errors } : out;
}

export function registrationValues(r?: Registration): FormValues {
  return {
    type: r?.type ?? '',
    number: r?.number ?? '',
    issuingAuthority: r?.issuingAuthority ?? '',
    issuedOn: r?.issuedOn ?? '',
    expiresOn: r?.expiresOn ?? '',
    notes: r?.notes ?? '',
  };
}

/** A registration as the server takes it, or the problems the server would report, by field. */
export function registrationRequest(v: FormValues): { body: RegistrationRequest } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const type = text(v, 'type').toLowerCase();
  const number = text(v, 'number').toUpperCase();
  if (!type) errors['type'] = required('ui.admin.organisation.regType');
  else if (!/^[a-z0-9_-]{1,40}$/.test(type)) errors['type'] = t('ui.admin.organisation.regTypeHint');
  if (!number) errors['number'] = required('ui.admin.organisation.regNumber');
  const issuedOn = text(v, 'issuedOn');
  const expiresOn = text(v, 'expiresOn');
  if (issuedOn && expiresOn && expiresOn < issuedOn) errors['expiresOn'] = t('ui.admin.organisation.expiryBeforeIssue');
  if (Object.keys(errors).length) return { errors };
  const body: RegistrationRequest = { type, number };
  const authority = text(v, 'issuingAuthority');
  const notes = text(v, 'notes');
  if (authority) body.issuingAuthority = authority;
  if (issuedOn) body.issuedOn = issuedOn;
  if (expiresOn) body.expiresOn = expiresOn;
  if (notes) body.notes = notes;
  return { body };
}

/**
 * The server's field issues by form key: `/address/line1` (a 400 schema
 * failure) and `address.line1` (a 422 validation failure) both become `line1`.
 * A duplicate registration (409) belongs on its number. Issues for no field
 * of this form are left out; the message shows them.
 */
export function fieldIssues(e: unknown, keys: readonly string[], conflictField?: string): { message: string; errors: Record<string, string> } {
  const g = asGatewayError(e, t('ui.common.somethingWentWrong'));
  const errors: Record<string, string> = {};
  for (const issue of g.issues ?? []) {
    const key = issue.path.replace(/^\/+/, '').split(/[./]/).filter(Boolean).at(-1) ?? '';
    if (keys.includes(key)) errors[key] ??= issue.message;
  }
  if (conflictField && g.code === 'conflict') errors[conflictField] = g.message;
  return { message: g.message, errors };
}

export const PROFILE_KEYS = [...CONTACT, ...ADDRESS, 'timezone'];
export const REGISTRATION_KEYS = Object.keys(registrationValues());

/** A logo the server would refuse, said before uploading: its type or size; null when it is fine. */
export function logoProblem(file: { type: string; size: number }): string | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return t('ui.admin.organisation.logoType');
  if (file.size > LOGO_MAX_BYTES) return t('ui.admin.organisation.logoSize');
  return null;
}

/** A signature the server would refuse, said before uploading. */
export function signatureProblem(file: { type: string; size: number }): string | null {
  if (file.type !== 'image/png') return t('ui.admin.organisation.signatureType');
  if (file.size > SIGNATURE_MAX_BYTES) return t('ui.admin.organisation.signatureSize');
  return null;
}

/** Blank name or designation, said before saving. */
export function signatoryErrors(name: string, designation: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!name.trim()) errors['name'] = t('ui.admin.organisation.signatoryNameRequired');
  else if (name.trim().length > 120) errors['name'] = t('ui.admin.organisation.signatoryNameRequired');
  if (!designation.trim()) errors['designation'] = t('ui.admin.organisation.signatoryDesignationRequired');
  else if (designation.trim().length > 120) errors['designation'] = t('ui.admin.organisation.signatoryDesignationRequired');
  return errors;
}

export interface SetupRow {
  key: SetupItem['key'];
  label: string;
  hint: string;
  done: boolean;
  required: boolean;
  /** The administrator confirms this step here. */
  confirm: boolean;
  /** Where this step is finished. */
  link: string;
}

/**
 * The screen for each setup step. Receipt rules live with the money definitions.
 * Email and payments are both connectors.
 */
const SETUP_DESTINATIONS: Record<SetupItem['key'], string> = {
  identity: '/admin/organisation/profile',
  registrations: '/admin/organisation/registrations',
  fiscalYear: '/admin/organisation/settings',
  receiptSeries: '/builder?section=money&kind=receiptRule',
  operationalRole: '/admin/roles',
  email: '/admin/connectors',
  payments: '/admin/connectors',
};

export function setupDestination(key: SetupItem['key']): string {
  return SETUP_DESTINATIONS[key];
}

/** The checklist as the screen lists it; identity and receipt series are confirmed here until done. */
export function setupRows(items: SetupItem[]): SetupRow[] {
  return items.map((i) => ({
    key: i.key,
    label: t(`ui.admin.organisation.setup.${i.key}`),
    hint:
      i.key === 'email'
        ? t(`ui.admin.organisation.setup.emailHint.${i.detail === 'organisation' || i.detail === 'installation' ? i.detail : 'none'}`)
        : t(`ui.admin.organisation.setup.${i.key}Hint`),
    done: i.done,
    required: i.required,
    confirm: !i.done && (i.key === 'identity' || i.key === 'receiptSeries'),
    link: setupDestination(i.key),
  }));
}

/** Required steps fill the bar. Optional steps are counted apart from it. */
export interface SetupProgress {
  done: number;
  total: number;
  optionalOpen: number;
  /** Labels of required steps still open, in checklist order. */
  remaining: string[];
  percent: number;
}

export function setupProgress(rows: SetupRow[]): SetupProgress {
  const required = rows.filter((row) => row.required);
  const done = required.filter((row) => row.done).length;
  const total = required.length;
  return {
    done,
    total,
    optionalOpen: rows.filter((row) => !row.required && !row.done).length,
    remaining: required.filter((row) => !row.done).map((row) => row.label),
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/** `{done} of {total} required`, and the open optional count when any remain. */
export function setupStatusText(progress: SetupProgress): string {
  const required = t('ui.admin.organisation.setupProgress', { done: progress.done, total: progress.total });
  if (progress.optionalOpen === 0) return required;
  return `${required} · ${t('ui.admin.organisation.setupOptional', { count: progress.optionalOpen })}`;
}

/** The required steps still open, or the line that setup is complete. */
export function setupDetailText(progress: SetupProgress, locale: string): string {
  if (progress.remaining.length === 0) return t('ui.admin.organisation.setupDone');
  return t('ui.admin.organisation.setupStill', { count: progress.remaining.length, names: listNames(progress.remaining, locale) });
}

function listNames(names: string[], locale: string): string {
  if (names.length <= 1) return names[0] ?? '';
  const Format = Intl.ListFormat;
  if (typeof Format !== 'function') return names.join(', ');
  return new Format(intlLocale(locale), { type: 'conjunction', style: 'long' }).format(names);
}

/** Zones some browsers still list under a name IANA has replaced. */
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Europe/Kiev': 'Europe/Kyiv',
};

/** A zone under its current IANA name, e.g. `Asia/Calcutta` is `Asia/Kolkata`. */
export function timezoneName(zone: string): string {
  return RENAMED[zone] ?? zone;
}

/** A zone as the box shows it: its current name, read as words. */
export function timezoneLabel(zone: string): string {
  return timezoneName(zone).replace(/_/g, ' ');
}

/** The time zones the browser knows, under their current names, with the current one kept even when it does not. */
export function timezoneOptions(current: string | null): { key: string; label: string }[] {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const named = zones.map(timezoneName);
  const chosen = current ? timezoneName(current) : '';
  const all = chosen && !named.includes(chosen) ? [chosen, ...named] : named;
  return [...new Set(all)].map((z) => ({ key: z, label: timezoneLabel(z) }));
}

/** A registration as one line: `80G · AAATC1234F · Income Tax Department`. */
export function registrationLine(r: Pick<Registration, 'type' | 'number' | 'issuingAuthority'>): string {
  return [r.type.toUpperCase(), r.number, r.issuingAuthority].filter(Boolean).join(' · ');
}
