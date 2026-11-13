import { describe, expect, it } from 'vitest';
import { acceptAttribute, asSignature, dataUrlBlob, fileHint, fileIds, fileNameFrom, fileProblem, formatSize, isSigned, kindOfFile, signedLine } from './files';
import { httpFiles } from '../http/http-files';
import type { BinaryHttpLike } from '../http/http';

describe('file fields', () => {
  it('builds the picker filter from the accepted kinds', () => {
    expect(acceptAttribute({ accept: ['image', 'pdf'] })).toBe('image/*,application/pdf,.pdf');
    expect(acceptAttribute({})).toContain('.xlsx');
  });

  it('tells the kind from the type, or the name when there is no type', () => {
    expect(kindOfFile({ name: 'house.jpg', type: 'image/jpeg' })).toBe('image');
    expect(kindOfFile({ name: 'logo.svg', type: 'image/svg+xml' })).toBeNull();
    expect(kindOfFile({ name: 'letter.PDF', type: '' })).toBe('pdf');
    expect(kindOfFile({ name: 'bank.xlsx', type: '' })).toBe('spreadsheet');
    expect(kindOfFile({ name: 'notes.docx' })).toBe('document');
    expect(kindOfFile({ name: 'run.exe', type: 'application/x-msdownload' })).toBeNull();
  });

  it('refuses a wrong kind or a file that is too large before uploading', () => {
    const f = { accept: ['image' as const, 'pdf' as const], maxSizeMb: 10 };
    expect(fileProblem(f, { name: 'a.jpg', type: 'image/jpeg', size: 3_000_000 })).toBeNull();
    expect(fileProblem(f, { name: 'bank.xlsx', type: '', size: 1000 })).toBe('This file type is not supported. Use Images, PDF.');
    expect(fileProblem(f, { name: 'big.pdf', type: 'application/pdf', size: 11 * 1024 * 1024 })).toBe('This file is too large. The limit is 10 MB.');
    expect(fileHint(f)).toBe('Images, PDF · ≤ 10 MB');
    expect(fileHint({})).toBe('Images, PDF, Documents, Spreadsheets · ≤ 25 MB');
    expect(formatSize(240 * 1024)).toBe('240 kB');
    expect(formatSize(3.14 * 1024 * 1024)).toBe('3.1 MB');
  });

  it('reads one or several file ids and the name from the download headers', () => {
    expect(fileIds('f1')).toEqual(['f1']);
    expect(fileIds(['f1', '', 3, 'f2'])).toEqual(['f1', 'f2']);
    expect(fileIds(null)).toEqual([]);
    expect(fileNameFrom(`inline; filename="R_vi photo.png"; filename*=UTF-8''${encodeURIComponent('Rāvi photo.png')}`, 'x')).toBe('Rāvi photo.png');
    expect(fileNameFrom('attachment; filename="donors.csv"', 'x')).toBe('donors.csv');
    expect(fileNameFrom(null, 'fallback')).toBe('fallback');
  });

  it('uploads the file itself with its name and target, and reads details from HEAD', async () => {
    const calls: unknown[] = [];
    const http: BinaryHttpLike = {
      async upload<T>(url: string, body: Blob, headers: Record<string, string>) {
        calls.push({ url, size: body.size, headers });
        return { id: 'f9', name: 'Rāvi.png', mime: 'image/png', size: body.size } as T;
      },
      async bytes(url, method = 'GET') {
        calls.push({ url, method });
        const headers: Record<string, string> = { 'content-type': 'application/pdf', 'content-length': '2048', 'content-disposition': 'inline; filename="letter.pdf"' };
        return { blob: new Blob(method === 'HEAD' ? [] : ['%PDF']), header: (n) => headers[n] ?? null };
      },
    };
    const files = httpFiles(http);
    const up = await files.upload(new Blob(['png'], { type: 'image/png' }), 'Rāvi.png', { type: 'beneficiary', field: 'photo' });
    expect(up.id).toBe('f9');
    expect(calls[0]).toEqual({ url: '/api/files?type=beneficiary&field=photo', size: 3, headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('Rāvi.png') } });
    expect(await files.info('f1')).toEqual({ id: 'f1', name: 'letter.pdf', mime: 'application/pdf', size: 2048 });
    expect(calls[1]).toEqual({ url: '/api/files/f1', method: 'HEAD' });
    expect((await files.download('f1')).info.size).toBe(4);
  });
});

describe('signature values', () => {
  it('tells a saved signature from a new drawing and describes who signed', () => {
    const saved = asSignature({ file: 'f1', signedAt: '2026-10-24T05:35:00Z', signedBy: 'Lakshmi Devi', extra: 1 });
    expect(saved).toEqual({ file: 'f1', signedAt: '2026-10-24T05:35:00Z', signedBy: 'Lakshmi Devi' });
    expect(isSigned(saved)).toBe(true);
    expect(signedLine(saved!)).toMatch(/^Signed by Lakshmi Devi on 24 Oct 2026, \d\d:\d\d$/);
    expect(isSigned(asSignature({ drawing: 'data:image/png;base64,AA==' }))).toBe(false);
    expect(asSignature({ signedBy: 'only a name' })).toBeNull();
    expect(asSignature('text')).toBeNull();
  });

  it('turns a drawn PNG into bytes for upload', async () => {
    const blob = dataUrlBlob('data:image/png;base64,iVBORw0KGgo=');
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer())].slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
