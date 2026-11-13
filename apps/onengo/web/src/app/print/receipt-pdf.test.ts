import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptPage } from '../core/records/print/print';
import { drawReceipt, jpegPdf, pdfName } from './receipt-pdf';

describe('receipt pdf', () => {
  it('names the file from the receipt number', () => {
    expect(pdfName('RCPT/2026-27/00040')).toBe('RCPT-2026-27-00040.pdf');
    expect(pdfName('  ')).toBe('receipt.pdf');
  });

  it('embeds the picture on one page and points the cross-reference at the objects', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]);
    const pdf = jpegPdf(jpeg, 100, 200);
    const text = latin1(pdf);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toContain('/Filter /DCTDecode /Length 7');
    expect(text).toContain('/Width 100');
    expect(text).toContain('/Height 200');
    expect(text).toContain('/MediaBox [0 0 595.28 1190.56]');
    expect(text.endsWith('%%EOF\n')).toBe(true);
    const start = Number(text.match(/startxref\n(\d+)/)![1]);
    expect(latin1(pdf.slice(start, start + 4))).toBe('xref');
    expect(indexOf(pdf, jpeg)).toBeGreaterThan(0);
    for (const match of text.matchAll(/\n(\d{10}) 00000 n \n/g)) {
      const at = Number(match[1]);
      expect(latin1(pdf.slice(at, at + 7))).toMatch(/^\d 0 obj$/);
    }
  });

  it('refuses an empty picture', () => {
    expect(() => jpegPdf(new Uint8Array([1]), 0, 10)).toThrow(/no size/);
  });

  it('draws each clause above the thank-you line', () => {
    const drawn: string[] = [];
    const ctx = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      textAlign: 'left' as CanvasTextAlign,
      textBaseline: 'top' as CanvasTextBaseline,
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillText: (text: string) => drawn.push(text),
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fillRect() {},
      strokeRect() {},
      translate() {},
      rotate() {},
      scale() {},
    };
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
    const page: ReceiptPage = {
      organisation: 'Demo',
      issuer: { name: 'Demo', alsoKnownAs: null, addressLines: [], contactLine: '', registrations: [], logoUrl: null, note: null },
      number: 'RCPT/1',
      date: '1 Apr 2026',
      title: 'Receipt',
      statement: null,
      rows: [{ label: 'Amount', value: '₹10.00' }],
      thanks: 'Thank you.',
      clauses: ['80G AAATD1234F'],
      voided: null,
      record: { type: 'donation', id: 'r1' },
      signatory: null,
    };
    drawReceipt(page, null, null);
    expect(drawn.indexOf('80G AAATD1234F')).toBeGreaterThanOrEqual(0);
    expect(drawn.indexOf('80G AAATD1234F')).toBeLessThan(drawn.indexOf('Thank you.'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function latin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
