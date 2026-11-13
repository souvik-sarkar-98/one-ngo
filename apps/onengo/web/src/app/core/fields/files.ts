import { currentTranslator, formatNumber, intlLocale, t } from '../i18n/i18n';
import type { FieldDef, FileKind } from '../models';

/** A stored file as the server describes it. */
export interface FileInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Where an upload is going, so the server applies that field's size limit and kinds. */
export interface UploadTarget {
  type: string;
  field: string;
}

export const ALL_FILE_KINDS: FileKind[] = ['image', 'pdf', 'document', 'spreadsheet'];

const KIND_TYPES: Record<FileKind, string[]> = {
  image: ['image/*'],
  pdf: ['application/pdf', '.pdf'],
  document: ['.doc', '.docx', '.ppt', '.pptx', '.txt', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  spreadsheet: ['.csv', '.xls', '.xlsx', 'text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

const EXTENSIONS: Record<FileKind, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  pdf: ['pdf'],
  document: ['doc', 'docx', 'ppt', 'pptx', 'txt'],
  spreadsheet: ['csv', 'xls', 'xlsx'],
};

/** Matches the server's own limit when a field sets none. */
export const DEFAULT_MAX_MB = 25;
/** The server refuses signature images above this. */
export const SIGNATURE_MAX_BYTES = 200 * 1024;

export const kindsOf = (f: Pick<FieldDef, 'accept'>): FileKind[] => (f.accept?.length ? f.accept : ALL_FILE_KINDS);

/** The file picker's `accept` attribute for a field. */
export function acceptAttribute(f: Pick<FieldDef, 'accept'>): string {
  return kindsOf(f).flatMap((k) => KIND_TYPES[k]).join(',');
}

/** The kind of a file from its type, or its name when the browser gives no type. The server checks the content again. */
export function kindOfFile(file: { name: string; type?: string; mime?: string }): FileKind | null {
  const mime = (file.type ?? file.mime ?? '').toLowerCase();
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (mime === 'application/pdf') return 'pdf';
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return ALL_FILE_KINDS.find((k) => EXTENSIONS[k].includes(ext)) ?? null;
}

/** Why a chosen file cannot be added to the field, before uploading; null when it may go. */
export function fileProblem(f: Pick<FieldDef, 'accept' | 'maxSizeMb'>, file: { name: string; type?: string; size: number }): string | null {
  const kinds = kindsOf(f);
  const kind = kindOfFile(file);
  if (!kind || !kinds.includes(kind)) return t('ui.fields.files.wrongKind', { kinds: kindsLabel(kinds) });
  const max = f.maxSizeMb ?? DEFAULT_MAX_MB;
  if (file.size > max * 1024 * 1024) return t('ui.fields.files.tooLarge', { size: formatSize(max * 1024 * 1024) });
  return null;
}

export function kindsLabel(kinds: FileKind[]): string {
  return kinds.map((k) => t(`ui.fields.files.kind.${k}`)).join(', ');
}

/** The hint under a file field, e.g. "Images, PDF · ≤ 10 MB". */
export function fileHint(f: Pick<FieldDef, 'accept' | 'maxSizeMb'>): string {
  return `${kindsLabel(kindsOf(f))} · ≤ ${formatSize((f.maxSizeMb ?? DEFAULT_MAX_MB) * 1024 * 1024)}`;
}

/** 240 kB, 3.1 MB, in the locale's own units. */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return formatNumber(Math.max(1, Math.round(bytes / 1024)), { style: 'unit', unit: 'kilobyte' });
  return formatNumber(Math.round((bytes / (1024 * 1024)) * 10) / 10, { style: 'unit', unit: 'megabyte' });
}

/** A short label for a file's kind in its thumbnail, e.g. PDF, XLSX. */
export function fileBadge(file: { name: string }): string {
  return (file.name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? '').toUpperCase();
}

export const isImage = (f: { mime: string }) => f.mime.startsWith('image/');
export const isPdf = (f: { mime: string }) => f.mime === 'application/pdf';

/** The file name from a content-disposition header, preferring the UTF-8 form. */
export function fileNameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // fall through to the plain name
    }
  }
  return /filename\s*=\s*"([^"]*)"/i.exec(disposition)?.[1] ?? fallback;
}

/** A file field's value as a list of file ids, whether it holds one or several. */
export function fileIds(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && !!x);
  return typeof v === 'string' && v ? [v] : [];
}

/** Stands in the form value for a file still uploading, so a save waits for it. */
export const UPLOADING = 'uploading:';
export const isUploading = (id: string) => id.startsWith(UPLOADING);

// ---------------------------------------------------------------- signatures

/**
 * A signature as a form holds it: the saved value (`file`, `signedAt`,
 * `signedBy`), or a new drawing waiting to be uploaded on save, with the name
 * typed for someone signing on the device.
 */
export interface SignatureValue {
  file?: string;
  signedAt?: string;
  signedBy?: string;
  /** A PNG data URL drawn on the pad, not yet uploaded. */
  drawing?: string;
}

export const isSigned = (v: SignatureValue | null | undefined): boolean => !!v?.signedAt && !!v.file;

export function asSignature(v: unknown): SignatureValue | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const s: SignatureValue = {};
  for (const k of ['file', 'signedAt', 'signedBy', 'drawing'] as const) if (typeof o[k] === 'string' && o[k]) s[k] = o[k] as string;
  return s.file || s.drawing ? s : null;
}

/** "Signed by Lakshmi Devi on 24 Oct 2026, 11:05". */
export function signedLine(v: SignatureValue): string {
  return t('ui.fields.signature.signedBy', { name: v.signedBy ?? '—', when: v.signedAt ? formatDateTime(v.signedAt) : '' });
}

/** A moment in the person's own time zone, e.g. 24 Oct 2026, 11:05. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(intlLocale(currentTranslator().locale), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** A data URL as a Blob, for uploading a drawn signature. */
export function dataUrlBlob(dataUrl: string): Blob {
  const [head = '', base64 = ''] = dataUrl.split(',', 2);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: /^data:([^;,]+)/.exec(head)?.[1] ?? 'application/octet-stream' });
}

/** Sends files to the server; the record session uses it to upload new signatures on save. */
export interface FileUploader {
  upload(file: Blob, name: string, target?: UploadTarget, progress?: (fraction: number) => void, signal?: AbortSignal): Promise<FileInfo>;
}
