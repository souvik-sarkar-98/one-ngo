import type { FileKind } from '../definitions/types.js';

/** The largest signature image a signature field accepts. */
export const SIGNATURE_MAX_BYTES = 200 * 1024;

const MIME_KIND: Record<string, FileKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  'application/msword': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'text/plain': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.ms-excel': 'spreadsheet',
  'text/csv': 'spreadsheet',
};

export function kindOfMime(mime: string): FileKind | null {
  return MIME_KIND[mime] ?? null;
}

