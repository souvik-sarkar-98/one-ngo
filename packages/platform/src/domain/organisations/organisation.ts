import type { FieldIssue } from '@onengo/kernel/ports';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A registration type such as `80g`, `12a` or `fcra`. */
export const REGISTRATION_TYPE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TIMEZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
export const ORGANISATION_CODE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
/** Codes that would read as a part of the product rather than an organisation. */
const RESERVED_CODES = new Set(['admin', 'api', 'app', 'internal', 'onengo', 'operator', 'sign-in', 'support', 'www']);

/** PNG, JPEG and WebP only: an SVG logo could carry script. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const LOGO_MAX_BYTES = 1024 * 1024;
/** A signature image is a PNG, the same limit as a signature field. */
export const SIGNATORY_MAX_BYTES = 200 * 1024;

export interface OrganisationContact {
  email: string | null;
  phone: string | null;
  website: string | null;
}

export interface OrganisationAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  /** ISO 3166-1 alpha-2, e.g. IN. */
  country: string;
}

export interface RegistrationInput {
  /** e.g. `trust`, `12a`, `80g`, `fcra`, `pan`, `csr-1`. */
  type: string;
  /** Trimmed and upper-cased; unique per type within the organisation. */
  number: string;
  issuingAuthority: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  notes: string | null;
}

export interface Registration extends RegistrationInput {
  id: string;
}

export interface OrganisationProfileFields {
  contact: OrganisationContact;
  address: OrganisationAddress | null;
  timezone: string | null;
}

export interface OrganisationProfileState extends OrganisationProfileFields {
  identityConfirmedAt: string | null;
  receiptsReviewedAt: string | null;
  setupCompletedAt: string | null;
}

/** The authorised signatory kept with a receipt. Any part may be absent. */
export interface IssuerSignatory {
  name: string | null;
  designation: string | null;
  file: { fileId: string; version: number } | null;
}

/** Who issued a receipt, kept with it as it stood when it was issued. */
export interface IssuerSnapshot {
  displayName: string;
  legalName: string | null;
  contact: OrganisationContact;
  address: OrganisationAddress | null;
  /** Registrations in force on the receipt date. */
  registrations: { type: string; number: string; issuingAuthority: string | null }[];
  logo: { fileId: string; version: number } | null;
  /** Absent on receipts issued before signatories were kept. */
  signatory?: IssuerSignatory | null;
}

/** Name and designation, both required. */
export function parseSignatory(value: unknown, issues: FieldIssue[]): { name: string; designation: string } | null {
  if (!knownKeys(value, '', ['name', 'designation'], issues)) return null;
  const name = text(value.name, 'name', issues, 120, true, 'The name');
  const designation = text(value.designation, 'designation', issues, 120, true, 'The designation');
  if (!name || !designation) return null;
  return { name, designation };
}

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

function text(value: unknown, path: string, issues: FieldIssue[], max: number, required: boolean, label: string): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) issues.push({ path, message: `${label} is required.` });
    return null;
  }
  if (typeof value !== 'string') {
    issues.push({ path, message: `${label} must be text.` });
    return null;
  }
  const v = value.trim().replace(/\s+/g, ' ');
  if (!v) {
    if (required) issues.push({ path, message: `${label} is required.` });
    return null;
  }
  if (v.length > max) issues.push({ path, message: `${label} is at most ${max} characters.` });
  return v;
}

function date(value: unknown, path: string, issues: FieldIssue[], label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    issues.push({ path, message: `${label} must be a date like 2026-04-01.` });
    return null;
  }
  return value;
}

/** Unknown properties are refused, so nothing unexpected (a password, say) is stored by accident. */
export function knownKeys(value: unknown, path: string, keys: readonly string[], issues: FieldIssue[]): value is Record<string, unknown> {
  const at = (k: string) => (path ? `${path}.${k}` : k);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path: path || '/', message: 'Expected an object.' });
    return false;
  }
  for (const k of Object.keys(value)) if (!keys.includes(k)) issues.push({ path: at(k), message: 'Not a known property.' });
  return true;
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

/** The organisation code in lowercase, when it can be one. */
export function organisationCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toLowerCase();
  return ORGANISATION_CODE.test(code) && !code.includes('--') && !RESERVED_CODES.has(code) ? code : undefined;
}

export function isTimezone(value: string): boolean {
  if (!TIMEZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function parseContact(value: unknown, path: string, issues: FieldIssue[], requireEmail: boolean): OrganisationContact {
  const empty = { email: null, phone: null, website: null };
  if (value === undefined && !requireEmail) return empty;
  if (!knownKeys(value, path, ['email', 'phone', 'website'], issues)) return empty;
  const email = text(value.email, join(path, 'email'), issues, 254, requireEmail, 'The email address');
  if (email && !EMAIL.test(email)) issues.push({ path: join(path, 'email'), message: 'Enter a valid email address.' });
  const phone = text(value.phone, join(path, 'phone'), issues, 20, false, 'The phone number');
  if (phone && !PHONE.test(phone)) issues.push({ path: join(path, 'phone'), message: 'Enter a phone number of digits, spaces, brackets or dashes, optionally starting with +.' });
  const website = text(value.website, join(path, 'website'), issues, 200, false, 'The website');
  if (website) {
    let ok = false;
    try {
      const u = new URL(website);
      ok = (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
    } catch {
      ok = false;
    }
    if (!ok) issues.push({ path: join(path, 'website'), message: 'Enter a web address starting with https://.' });
  }
  return { email: email?.toLowerCase() ?? null, phone, website };
}

export function parseAddress(value: unknown, path: string, issues: FieldIssue[]): OrganisationAddress | null {
  if (!knownKeys(value, path, ['line1', 'line2', 'city', 'state', 'postalCode', 'country'], issues)) return null;
  const line1 = text(value.line1, join(path, 'line1'), issues, 200, true, 'The first address line');
  const line2 = text(value.line2, join(path, 'line2'), issues, 200, false, 'The second address line');
  const city = text(value.city, join(path, 'city'), issues, 100, true, 'The city');
  const state = text(value.state, join(path, 'state'), issues, 100, false, 'The state or region');
  const postalCode = text(value.postalCode, join(path, 'postalCode'), issues, 20, true, 'The postal code');
  const rawCountry = text(value.country, join(path, 'country'), issues, 60, true, 'The country');
  const country = rawCountry?.toUpperCase() ?? null;
  if (country && !/^[A-Z]{2}$/.test(country)) issues.push({ path: join(path, 'country'), message: 'Use the two-letter country code, e.g. IN.' });
  if (!line1 || !city || !postalCode || !country) return null;
  return { line1, line2, city, state, postalCode, country };
}

export function parseRegistration(value: unknown, path: string, issues: FieldIssue[]): RegistrationInput | null {
  const before = issues.length;
  if (!knownKeys(value, path, ['type', 'number', 'issuingAuthority', 'issuedOn', 'expiresOn', 'notes'], issues)) return null;
  const type = text(value.type, join(path, 'type'), issues, 40, true, 'The registration type')?.toLowerCase() ?? null;
  if (type && !REGISTRATION_TYPE.test(type)) {
    issues.push({ path: join(path, 'type'), message: 'Use lowercase letters, digits, - or _ for the registration type, e.g. 80g.' });
  }
  const number = text(value.number, join(path, 'number'), issues, 80, true, 'The registration number')?.toUpperCase() ?? null;
  const issuingAuthority = text(value.issuingAuthority, join(path, 'issuingAuthority'), issues, 200, false, 'The issuing authority');
  const issuedOn = date(value.issuedOn, join(path, 'issuedOn'), issues, 'The issue date');
  const expiresOn = date(value.expiresOn, join(path, 'expiresOn'), issues, 'The expiry date');
  if (issuedOn && expiresOn && expiresOn < issuedOn) issues.push({ path: join(path, 'expiresOn'), message: 'The expiry date cannot be before the issue date.' });
  const notes = text(value.notes, join(path, 'notes'), issues, 500, false, 'The notes');
  if (issues.length > before || !type || !number) return null;
  return { type, number, issuingAuthority, issuedOn, expiresOn, notes };
}

/** Index paths of registrations that repeat an earlier type and number. */
export function duplicateRegistrations(rows: (RegistrationInput | null)[], path: string): FieldIssue[] {
  const seen = new Set<string>();
  const issues: FieldIssue[] = [];
  rows.forEach((r, i) => {
    if (!r) return;
    const key = `${r.type}\u0000${r.number}`;
    if (seen.has(key)) issues.push({ path: `${path}[${i}].number`, message: 'This registration is listed twice.' });
    seen.add(key);
  });
  return issues;
}

export const DUPLICATE_REGISTRATION = 'The organisation already has a registration of this type with this number.';