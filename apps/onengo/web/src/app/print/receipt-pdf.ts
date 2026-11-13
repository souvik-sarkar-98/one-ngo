import { t } from '../core/i18n/i18n';
import type { ReceiptPage } from '../core/records/print/print';

const WIDTH = 720;
const SCALE = 2;
const PAD = 36;
const INK = '#0f172a';
const MUTED = '#475569';
const LABEL = '#334155';
const LINE = '#0f172a';
const RULE = '#cbd5e1';
const VOID = 'rgba(185, 28, 28, 0.28)';
const FONT = '"Segoe UI", "Nirmala UI", Roboto, Helvetica, Arial, sans-serif';

type Weight = 400 | 600 | 700;
type Paint = (ctx: CanvasRenderingContext2D) => void;

/** A file name from the receipt number, safe to offer as a download. */
export function pdfName(number: string): string {
  const safe = number.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'receipt'}.pdf`;
}

/**
 * A one-page PDF whose only content is a JPEG of the receipt. The page matches
 * the picture's shape, so the browser's fonts (including Indic text) stay as drawn.
 */
export function jpegPdf(jpeg: Uint8Array, pixelWidth: number, pixelHeight: number): Uint8Array {
  if (pixelWidth < 1 || pixelHeight < 1) throw new Error('Receipt image has no size.');
  const pageW = 595.28;
  const pageH = Math.round(((pageW * pixelHeight) / pixelWidth) * 100) / 100;
  const content = `q\n${pageW} 0 0 ${pageH} 0 0 cm\n/Im0 Do\nQ`;
  const contentBytes = ascii(content);
  const objects = [
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`),
    concat([ascii(`<< /Length ${contentBytes.length} >>\nstream\n`), contentBytes, ascii('\nendstream')]),
    concat([
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      ascii('\nendstream'),
    ]),
  ];
  const header = concat([ascii('%PDF-1.4\n'), new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]);
  const chunks: Uint8Array[] = [header];
  const offsets = [0];
  let pos = header.length;
  objects.forEach((body, index) => {
    offsets.push(pos);
    const wrapped = concat([ascii(`${index + 1} 0 obj\n`), body, ascii('\nendobj\n')]);
    chunks.push(wrapped);
    pos += wrapped.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(ascii(xref));
  return concat(chunks);
}

/** Draws the receipt the way the print page shows it, then the caller saves it as a PDF. */
export function drawReceipt(page: ReceiptPage, logo: HTMLImageElement | null, signature: HTMLImageElement | null = null): HTMLCanvasElement {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) throw new Error('Canvas is not available.');
  const painted = layout(page, logo, signature, probe);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH * SCALE;
  canvas.height = painted.height * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, painted.height);
  for (const paint of painted.paint) paint(ctx);
  return canvas;
}

export async function canvasJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Could not encode the receipt.');
  return new Uint8Array(await blob.arrayBuffer());
}

export function savePdf(bytes: Uint8Array, name: string): void {
  const blob = new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function layout(page: ReceiptPage, logo: HTMLImageElement | null, signature: HTMLImageElement | null, probe: CanvasRenderingContext2D): { height: number; paint: Paint[] } {
  const paint: Paint[] = [];
  let y = PAD;
  const inner = WIDTH - PAD * 2;
  const rightW = 200;
  const leftW = inner - rightW - 16;
  const leftX = PAD;
  let textX = leftX;
  let textW = leftW;
  if (logo) {
    const logoY = y;
    paint.push((ctx) => ctx.drawImage(logo, leftX, logoY, 64, 64));
    textX = leftX + 76;
    textW = leftW - 76;
  }
  const leftLines: Array<{ text: string; size: number; weight: Weight; color: string }> = [
    { text: page.issuer.name, size: 18, weight: 700, color: INK },
    ...(page.issuer.alsoKnownAs ? [{ text: page.issuer.alsoKnownAs, size: 14, weight: 400 as const, color: MUTED }] : []),
    ...page.issuer.addressLines.map((text) => ({ text, size: 14, weight: 400 as const, color: MUTED })),
    ...(page.issuer.contactLine ? [{ text: page.issuer.contactLine, size: 14, weight: 400 as const, color: MUTED }] : []),
    ...page.issuer.registrations.map((text) => ({ text, size: 13, weight: 400 as const, color: MUTED })),
  ];
  let leftY = y;
  for (const line of leftLines) leftY += queueText(paint, probe, line.text, { x: textX, y: leftY, width: textW, ...line, align: 'left' });
  const rightX = WIDTH - PAD - rightW;
  let rightY = y;
  rightY += queueText(paint, probe, page.number, { x: rightX, y: rightY, width: rightW, size: 16, weight: 700, color: INK, align: 'right' });
  rightY += queueText(paint, probe, page.date, { x: rightX, y: rightY, width: rightW, size: 14, weight: 400, color: MUTED, align: 'right' });
  y = Math.max(leftY, rightY, logo ? y + 64 : y) + 12;
  if (page.issuer.note) {
    y += queueText(paint, probe, page.issuer.note, { x: PAD, y, width: inner, size: 13, weight: 400, color: MUTED, align: 'left' });
    y += 8;
  }
  rule(paint, PAD, y, inner);
  y += 16;
  y += queueText(paint, probe, page.title, { x: PAD, y, width: inner, size: 20, weight: 700, color: INK, align: 'center' });
  y += 10;
  rule(paint, PAD, y, inner);
  y += 14;
  if (page.statement) {
    y += queueText(paint, probe, page.statement, { x: PAD, y, width: inner, size: 14, weight: 400, color: INK, align: 'left' });
    y += 14;
  }
  const labelW = Math.round(inner * 0.4);
  const valueX = PAD + labelW + 12;
  const valueW = inner - labelW - 12;
  const rowsTop = y;
  page.rows.forEach((row, index) => {
    if (index > 0) rule(paint, PAD, y, inner, RULE);
    y += 8;
    const rowY = y;
    const labelH = queueText(paint, probe, row.label, { x: PAD + 10, y: rowY, width: labelW - 20, size: 15, weight: 600, color: LABEL, align: 'left' });
    const valueH = queueText(paint, probe, row.value, { x: valueX, y: rowY, width: valueW - 10, size: 15, weight: 400, color: INK, align: 'left' });
    y += Math.max(labelH, valueH) + 8;
  });
  if (page.rows.length) {
    const rowsBottom = y;
    const split = PAD + labelW;
    paint.push((ctx) => {
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD, rowsTop, inner, rowsBottom - rowsTop);
      ctx.beginPath();
      ctx.moveTo(split, rowsTop);
      ctx.lineTo(split, rowsBottom);
      ctx.stroke();
    });
  }
  for (const clause of page.clauses) {
    y += 14;
    y += queueText(paint, probe, clause, { x: PAD, y, width: inner, size: 14, weight: 400, color: INK, align: 'left' });
  }
  y += 16;
  y += queueText(paint, probe, page.thanks, { x: PAD, y, width: inner, size: 14, weight: 400, color: MUTED, align: 'center' });
  y += signature ? 28 : 48;
  const signW = 200;
  const signX = WIDTH - PAD - signW;
  if (signature) {
    const fitted = fitImage(signature, signW, 72);
    const imageX = signX + (signW - fitted.width) / 2;
    const imageY = y;
    paint.push((ctx) => ctx.drawImage(signature, imageX, imageY, fitted.width, fitted.height));
    y += fitted.height + 8;
  }
  const lineY = y;
  paint.push((ctx) => {
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(signX, lineY);
    ctx.lineTo(signX + signW, lineY);
    ctx.stroke();
  });
  y += 8;
  if (page.signatory?.name) y += queueText(paint, probe, page.signatory.name, { x: signX, y, width: signW, size: 14, weight: 600, color: INK, align: 'center' });
  if (page.signatory?.designation) y += queueText(paint, probe, page.signatory.designation, { x: signX, y, width: signW, size: 13, weight: 400, color: MUTED, align: 'center' });
  y += queueText(paint, probe, t('ui.print.signatory'), { x: signX, y, width: signW, size: 14, weight: 400, color: INK, align: 'center' });
  const height = y + PAD;
  paint.push((ctx) => {
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, WIDTH - 20, height - 20);
    ctx.lineWidth = 1;
    ctx.strokeRect(15, 15, WIDTH - 30, height - 30);
  });
  if (page.voided) {
    const stamp = page.voided;
    const stampY = height * 0.42;
    const size = fitSize(probe, stamp, inner, 36);
    paint.push((ctx) => {
      ctx.save();
      ctx.translate(WIDTH / 2, stampY);
      ctx.rotate((-12 * Math.PI) / 180);
      ctx.font = font(size, 700);
      ctx.fillStyle = VOID;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(stamp, 0, 0);
      ctx.restore();
    });
  }
  return { height, paint };
}

function rule(paint: Paint[], x: number, y: number, width: number, color = LINE): void {
  paint.push((ctx) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + width, y);
    ctx.stroke();
  });
}

function queueText(
  paint: Paint[],
  probe: CanvasRenderingContext2D,
  text: string,
  box: { x: number; y: number; width: number; size: number; weight: Weight; color: string; align: CanvasTextAlign },
): number {
  if (!text.trim()) return 0;
  const face = font(box.size, box.weight);
  const lines = wrap(probe, text, face, box.width);
  const lineHeight = Math.round(box.size * 1.4);
  const { x, y, width, color, align } = box;
  paint.push((ctx) => {
    ctx.font = face;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    const origin = align === 'right' ? x + width : align === 'center' ? x + width / 2 : x;
    lines.forEach((line, index) => ctx.fillText(line, origin, y + index * lineHeight));
  });
  return lines.length * lineHeight;
}

function wrap(probe: CanvasRenderingContext2D, text: string, face: string, maxWidth: number): string[] {
  probe.font = face;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (probe.measureText(next).width <= maxWidth) line = next;
    else {
      if (line) lines.push(line);
      line = probe.measureText(word).width > maxWidth ? breakWord(probe, word, maxWidth, lines) : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function breakWord(probe: CanvasRenderingContext2D, word: string, maxWidth: number, lines: string[]): string {
  let chunk = '';
  for (const ch of word) {
    const next = chunk + ch;
    if (probe.measureText(next).width > maxWidth && chunk) {
      lines.push(chunk);
      chunk = ch;
    } else chunk = next;
  }
  return chunk;
}

function fitImage(image: HTMLImageElement, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  return { width: Math.max(1, image.width * scale), height: Math.max(1, image.height * scale) };
}

function fitSize(probe: CanvasRenderingContext2D, text: string, maxWidth: number, start: number): number {
  for (let size = start; size >= 16; size -= 2) {
    probe.font = font(size, 700);
    if (probe.measureText(text).width <= maxWidth) return size;
  }
  return 16;
}

function font(size: number, weight: Weight): string {
  return `${weight} ${size}px ${FONT}`;
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
