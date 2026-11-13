import { compileExpression } from '../../server';
import { issuesByField } from '../../fields/fields';
import { asSignature, fileIds, isSigned, isUploading, type SignatureValue, type UploadTarget } from '../../fields/files';
import { t } from '../../i18n/i18n';
import { fromLocationDraft, locationProblems, toLocationDraft, type LocationDraft } from '../../fields/location';
import type { FieldDef, FieldType, FileKind } from '../../models';

/** Whatever has fields to fill in: a record type, or a configured action's small form. */
export interface FieldSet {
  /** Set for record types; file uploads name it so the server applies the field's limits. */
  key?: string;
  fields: FieldDef[];
  /** Record types: fields a lookup's answer fills are shown, not typed. */
  lookups?: { connector: string; map: Record<string, string> }[];
}

export interface Viewer {
  id: string;
  roles: string[];
}

/**
 * A value as a form holds it: text, a flag, a list (multiple choice, file ids),
 * a location being typed, or a signature (saved, or drawn and not yet uploaded).
 */
export type FormValue = string | boolean | string[] | null | LocationDraft | SignatureValue;
export type FormValues = Record<string, FormValue>;

/** A form field, independent of how any screen draws it. */
export interface FieldModel {
  key: string;
  label: string;
  kind: FieldType;
  required: boolean;
  readOnly: boolean;
  /** Calculated or rolled up: the server keeps the value. */
  calculated: boolean;
  options: { value: string; label: string }[];
  help?: string;
  /** Grey example text shown while the field is empty. */
  placeholder?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  /** The record type a reference field chooses from. */
  referenceType?: string;
  pattern?: string;
  patternMessage?: string;
  /** File fields. */
  multiple?: boolean;
  accept?: FileKind[];
  maxSizeMb?: number;
  /** File and signature fields: where uploads go. */
  upload?: UploadTarget;
  /** Location fields: false when coordinates may not be typed. */
  typedCoordinates?: false;
  /** Signature fields: the signer's name is asked for. */
  typedName?: true;
}

/** Calculated and rollup fields are kept by the server and never sent. */
export const isComputed = (f: Pick<FieldDef, 'calculated' | 'rollup'>) => !!f.calculated || !!f.rollup;

/** Evaluates a field condition with the same expression language the server uses. */
export function conditionHolds(source: string | undefined, record: Record<string, unknown>, status: string | null, viewer: Viewer): boolean {
  if (!source) return true;
  try {
    return compileExpression(source).test({ record, status, previous: {}, previousStatus: null, user: viewer });
  } catch {
    return true;
  }
}

/**
 * The keys a workflow step's form offers: the fields the step requires, then
 * the fields the state it moves to reveals and lets the person fill, so a
 * value that only belongs to the new state can be entered as the step runs.
 */
export function stepKeys(
  type: FieldSet,
  step: { to: string; requiredFields?: string[] },
  record: Record<string, unknown>,
  status: string | null,
  viewer: Viewer,
): string[] {
  const required = step.requiredFields ?? [];
  const revealed = type.fields.filter(
    (f) =>
      !required.includes(f.key) &&
      !isComputed(f) &&
      f.visibleWhen &&
      !conditionHolds(f.visibleWhen, record, status, viewer) &&
      conditionHolds(f.visibleWhen, record, step.to, viewer) &&
      conditionHolds(f.editableWhen, record, step.to, viewer),
  );
  return [...required, ...revealed.map((f) => f.key)];
}

export interface FieldOptions {
  /** Show calculated fields (read-only) as well. */
  calculated?: boolean;
  /** Nothing can be changed, e.g. the record is locked or the person may not edit. */
  readOnly?: boolean;
}

/**
 * The fields of a form for the given keys. Fields whose visibleWhen is false
 * for the record are left out; fields whose editableWhen is false are
 * read-only. The server applies the same rules on save.
 */
export function fieldModels(
  type: FieldSet,
  keys: string[],
  record: Record<string, unknown>,
  status: string | null,
  viewer: Viewer,
  opts: FieldOptions = {},
): FieldModel[] {
  const out: FieldModel[] = [];
  const filledBy = new Map((type.lookups ?? []).flatMap((l) => Object.keys(l.map).map((field) => [field, l.connector] as const)));
  for (const key of keys) {
    const f = type.fields.find((x) => x.key === key);
    if (!f || (isComputed(f) && !opts.calculated) || !conditionHolds(f.visibleWhen, record, status, viewer)) continue;
    const connector = filledBy.get(f.key);
    const m = model(f, !!opts.readOnly || isComputed(f) || connector !== undefined || !conditionHolds(f.editableWhen, record, status, viewer), type.key);
    out.push(connector === undefined ? m : { ...m, help: [f.help, t('ui.records.lookupFilled', { connector })].filter(Boolean).join(' ') });
  }
  return out;
}

function model(f: FieldDef, readOnly: boolean, typeKey?: string): FieldModel {
  const computed = isComputed(f);
  return {
    key: f.key,
    label: f.label,
    kind: f.type,
    required: !!f.required && !computed,
    readOnly,
    calculated: computed,
    options: f.choices ?? [],
    help: f.help,
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    min: f.min,
    max: f.max,
    maxLength: f.maxLength,
    referenceType: f.referenceType,
    ...(f.pattern ? { pattern: f.pattern, patternMessage: f.patternMessage } : {}),
    ...(f.type === 'file' ? { multiple: !!f.multiple, accept: f.accept, maxSizeMb: f.maxSizeMb } : {}),
    ...((f.type === 'file' || f.type === 'signature') && typeKey ? { upload: { type: typeKey, field: f.key } } : {}),
    ...(f.type === 'location' && f.typedCoordinates === false ? { typedCoordinates: false as const } : {}),
    ...(f.type === 'signature' && f.typedName ? { typedName: true as const } : {}),
  };
}

/** A stored person as `{ id, name }`, or the user id itself. */
export function personId(v: unknown): unknown {
  return v && typeof v === 'object' && 'id' in v && 'name' in v ? v.id : v;
}

/**
 * A stored value as a form holds it: booleans stay booleans, multiple choice
 * and files become lists, locations and signatures keep their shape, people
 * become their id, and everything else becomes text ('' when empty).
 */
export function toFormValue(f: FieldDef, v: unknown): FormValue {
  switch (f.type) {
    case 'boolean':
      return v === true;
    case 'person':
      v = personId(v);
      return v === undefined || v === null ? '' : String(v);
    case 'multiChoice':
    case 'file':
      return fileIds(v);
    case 'location':
      return toLocationDraft(v);
    case 'signature':
      return asSignature(v);
    default:
      return v === undefined || v === null ? '' : String(v);
  }
}

/** What a list, location or signature form value sends; undefined leaves the field out (a drawing not yet uploaded). */
function fromStructured(f: FieldDef, v: FormValue): unknown {
  if (f.type === 'multiChoice') return Array.isArray(v) && v.length ? v : null;
  if (f.type === 'file') {
    const ids = Array.isArray(v) ? v.filter((id) => !isUploading(id)) : [];
    return f.multiple ? (ids.length ? ids : null) : (ids[0] ?? null);
  }
  if (f.type === 'location') return v && typeof v === 'object' && !Array.isArray(v) ? fromLocationDraft({ lat: '', lng: '', accuracy: '', label: '', ...(v as Partial<LocationDraft>) }) : null;
  const s = asSignature(v);
  if (!s) return null;
  if (isSigned(s)) return { file: s.file, signedAt: s.signedAt, signedBy: s.signedBy };
  if (!s.file) return undefined;
  return s.signedBy?.trim() ? { file: s.file, signedBy: s.signedBy.trim() } : { file: s.file };
}

const STRUCTURED = new Set<FieldType>(['multiChoice', 'file', 'location', 'signature']);

export function toFormValues(type: FieldSet, data: Record<string, unknown>): FormValues {
  const out: FormValues = {};
  for (const f of type.fields) out[f.key] = toFormValue(f, data[f.key]);
  return out;
}

/** Turns form values into API data: blanks become null, numbers become numbers. */
export function fromFormValues(type: FieldSet, values: FormValues, keys?: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of type.fields) {
    if (isComputed(f) || !(f.key in values) || (keys && !keys.includes(f.key))) continue;
    const v = values[f.key];
    if (STRUCTURED.has(f.type)) {
      const sent = fromStructured(f, v ?? null);
      if (sent !== undefined) out[f.key] = sent;
    } else if (f.type === 'boolean') out[f.key] = v === true;
    else if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) out[f.key] = null;
    else if ((f.type === 'number' || f.type === 'money') && typeof v === 'string') {
      const n = Number(v.trim());
      out[f.key] = Number.isFinite(n) ? n : v.trim();
    } else if (typeof v === 'string') out[f.key] = v.trim();
    else out[f.key] = v;
  }
  return out;
}

/** Only values that differ from the stored record. */
export function changedOnly(record: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const before = (typeof v === 'string' ? personId(record[k]) : record[k]) ?? null;
    if (JSON.stringify(before) !== JSON.stringify(v ?? null) && !(before === null && v === false)) out[k] = v;
  }
  return out;
}

function isEmpty(f: FieldModel, v: FormValue | undefined): boolean {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return true;
  if (Array.isArray(v)) return !v.length;
  if (f.kind === 'location' && typeof v === 'object') return !(v as LocationDraft).lat?.trim() || !(v as LocationDraft).lng?.trim();
  if (f.kind === 'signature') return !asSignature(v);
  return false;
}

/** Required fields that are empty. */
export function missingRequired(fields: FieldModel[], values: FormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (!f.required || f.readOnly || f.kind === 'boolean') continue;
    if (isEmpty(f, values[f.key])) out[f.key] = t('ui.records.required', { field: f.label });
  }
  return out;
}

/** The same shapes the server accepts, loosely, so a valid value is never refused here; the server checks again on save. */
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;

function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u').test(value);
  } catch {
    return true;
  }
}

/**
 * Everything the form can tell before saving: required fields, format rules,
 * typed coordinates out of range, and files still uploading. The server checks
 * the same rules (and unique values) again on save.
 */
export function formProblems(fields: FieldModel[], values: FormValues): Record<string, string> {
  const out = missingRequired(fields, values);
  for (const f of fields) {
    if (f.readOnly || out[f.key]) continue;
    const v = values[f.key];
    if (f.kind === 'email' && typeof v === 'string' && v.trim() && !EMAIL.test(v.trim())) out[f.key] = t('ui.fields.emailInvalid');
    else if (f.kind === 'phone' && typeof v === 'string' && v.trim() && !PHONE.test(v.trim())) out[f.key] = t('ui.fields.phoneInvalid');
    else if (f.pattern && typeof v === 'string' && v.trim() && !matches(f.pattern, v.trim())) out[f.key] = f.patternMessage || t('ui.fields.patternMismatch');
    else if (f.kind === 'file' && Array.isArray(v) && v.some(isUploading)) out[f.key] = t('ui.fields.files.waitForUploads');
    else if (f.kind === 'location' && v && typeof v === 'object' && !Array.isArray(v)) {
      const p = locationProblems({ lat: '', lng: '', accuracy: '', label: '', ...(v as Partial<LocationDraft>) });
      if (p.lat || p.lng) out[f.key] = (p.lat ?? p.lng)!;
    }
  }
  return out;
}

const sentence = (m: string): string => {
  const s = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

/**
 * A server issue as the message under its field. The server often sends a
 * fragment ("is required", "must be text"); this puts the field's name in
 * front so the message reads as a complete sentence on its own.
 */
export function friendlyIssue(label: string, message: string): string {
  const m = message.trim();
  if (!m || !label) return m;
  if (m.toLowerCase().includes(label.toLowerCase())) return sentence(m);
  if (/^required\.?$/i.test(m)) return t('ui.records.required', { field: label });
  if (/^(is|are|must|should|cannot|can't|needs?|has|have)\b/i.test(m)) return sentence(`${label} ${m}`);
  // A short bare remark such as "Too small" says nothing alone: "Amount: too small."
  if (!/[.!?]$/.test(m) && m.split(/\s+/).length <= 4) return `${label}: ${m.charAt(0).toLowerCase()}${m.slice(1)}.`;
  return sentence(m);
}

/** Server issues split into per-field messages and the rest; `labels` (field key to name) completes the field messages. */
export function splitIssues(
  message: string,
  issues: { path: string; message: string }[],
  labels?: Record<string, string>,
): { fields: Record<string, string>; general: string[] } {
  const fields = issuesByField(issues);
  if (labels) for (const key of Object.keys(fields)) if (labels[key]) fields[key] = friendlyIssue(labels[key]!, fields[key]!);
  const general = issues
    .filter((i) => !fields[i.path.replace(/^\//, '')] || i.path === '/')
    .map((i) => i.message)
    .filter((m) => m !== message);
  return { fields, general };
}
