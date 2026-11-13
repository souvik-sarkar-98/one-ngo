import { validationFailed } from '@onengo/kernel/errors';
import type { FileKind } from '../../runtime/definitions/types.js';

export interface DetectedType {
  mime: string;
  kind: FileKind;
}

type Family = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'zip' | 'ole' | 'text';

const HEAD_BYTES = 4096;
const MAGIC_BYTES = 16;
const TAIL_BYTES = 1024 * 1024;
const OLE_MARKERS = ['WordDocument', 'Workbook', 'PowerPoint Document', '_VBA_PROJECT'].map((m) => [m, Buffer.from(m, 'utf16le')] as const);
const OLE_CARRY = Math.max(...OLE_MARKERS.map(([, b]) => b.length)) - 1;

const refused = () => validationFailed('This type of file is not allowed. Upload an image, a PDF, an office document or a CSV file.');

function startsWith(head: Buffer, bytes: number[], at = 0): boolean {
  return head.length >= at + bytes.length && bytes.every((b, i) => head[at + i] === b);
}

function magic(head: Buffer): Family | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  const ascii = head.toString('latin1', 0, 12);
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  if (ascii.startsWith('%PDF-')) return 'pdf';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  return null;
}

/** Entry names from a zip's central directory, when it lies within the kept tail. */
function zipNames(tail: Buffer, total: number): string[] | null {
  const tailStart = total - tail.length;
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - 22 - 65_535); i--) {
    if (tail.readUInt32LE(i) !== 0x06054b50) continue;
    const size = tail.readUInt32LE(i + 12);
    const offset = tail.readUInt32LE(i + 16);
    if (offset < tailStart || offset + size > total) return null;
    const names: string[] = [];
    let p = offset - tailStart;
    const end = p + size;
    while (p + 46 <= end && tail.readUInt32LE(p) === 0x02014b50) {
      const n = tail.readUInt16LE(p + 28);
      names.push(tail.toString('utf8', p + 46, p + 46 + n));
      p += 46 + n + tail.readUInt16LE(p + 30) + tail.readUInt16LE(p + 32);
    }
    return names;
  }
  return null;
}

function officeOpenXml(names: string[] | null): DetectedType {
  if (!names?.includes('[Content_Types].xml')) throw refused();
  if (names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n))) throw validationFailed('Office files with macros are not allowed.');
  if (names.some((n) => n.startsWith('word/'))) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document' };
  if (names.some((n) => n.startsWith('xl/'))) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'spreadsheet' };
  if (names.some((n) => n.startsWith('ppt/'))) return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'document' };
  throw refused();
}

function legacyOffice(markers: Set<string>): DetectedType {
  if (markers.has('_VBA_PROJECT')) throw validationFailed('Office files with macros are not allowed.');
  if (markers.has('WordDocument')) return { mime: 'application/msword', kind: 'document' };
  if (markers.has('Workbook')) return { mime: 'application/vnd.ms-excel', kind: 'spreadsheet' };
  if (markers.has('PowerPoint Document')) return { mime: 'application/vnd.ms-powerpoint', kind: 'document' };
  throw refused();
}

function plainText(head: Buffer, name: string): DetectedType {
  const start = head.toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (start.startsWith('<') || /<(script|html|body|iframe|svg|object|embed)\b/.test(start)) throw refused();
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === 'csv') return { mime: 'text/csv', kind: 'spreadsheet' };
  if (ext === 'txt') return { mime: 'text/plain', kind: 'document' };
  throw refused();
}

/**
 * Decides a file's type from its bytes as they stream past: images, PDF,
 * Office Open XML (a zip with `[Content_Types].xml`), legacy Office (OLE
 * compound files), and UTF-8 text named .csv or .txt. Anything else, and
 * text that looks like markup, is refused. Only the head and, for zips, the
 * tail are kept in memory.
 */
export class FileSniffer {
  private head = Buffer.alloc(0);
  private pending: Buffer[] = [];
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private total = 0;
  private family: Family | null = null;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private carry = Buffer.alloc(0);
  private readonly markers = new Set<string>();

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.head.length < HEAD_BYTES) this.head = Buffer.concat([this.head, chunk.subarray(0, HEAD_BYTES - this.head.length)]);
    if (this.family === null || this.family === 'zip') this.keepTail(chunk);
    if (this.family !== null) return this.scan(chunk);
    this.pending.push(chunk);
    if (this.head.length >= MAGIC_BYTES) this.decide();
  }

  finish(name: string): DetectedType {
    if (this.total === 0) throw validationFailed('The file is empty.');
    if (this.family === null) this.decide();
    switch (this.family!) {
      case 'png':
        return { mime: 'image/png', kind: 'image' };
      case 'jpeg':
        return { mime: 'image/jpeg', kind: 'image' };
      case 'gif':
        return { mime: 'image/gif', kind: 'image' };
      case 'webp':
        return { mime: 'image/webp', kind: 'image' };
      case 'pdf':
        return { mime: 'application/pdf', kind: 'pdf' };
      case 'zip':
        return officeOpenXml(zipNames(Buffer.concat(this.tail), this.total));
      case 'ole':
        return legacyOffice(this.markers);
      case 'text':
        try {
          this.decoder.decode();
        } catch {
          throw refused();
        }
        return plainText(this.head, name);
    }
  }

  private decide(): void {
    this.family = magic(this.head) ?? 'text';
    if (this.family !== 'zip') this.tail = [];
    for (const c of this.pending.splice(0)) this.scan(c);
  }

  private scan(chunk: Buffer): void {
    if (this.family === 'text') {
      if (chunk.includes(0)) throw refused();
      try {
        this.decoder.decode(chunk, { stream: true });
      } catch {
        throw refused();
      }
    } else if (this.family === 'ole') {
      const window = Buffer.concat([this.carry, chunk]);
      for (const [name, bytes] of OLE_MARKERS) if (window.includes(bytes)) this.markers.add(name);
      this.carry = window.subarray(Math.max(0, window.length - OLE_CARRY));
    }
  }

  private keepTail(chunk: Buffer): void {
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= TAIL_BYTES) this.tailBytes -= this.tail.shift()!.length;
  }
}
