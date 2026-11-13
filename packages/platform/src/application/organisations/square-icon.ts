import { createRequire } from 'node:module';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const decodeJpeg = createRequire(import.meta.url)('jpeg-js').decode as (
  jpegData: Buffer,
  opts?: { useTArray?: boolean; formatAsRGBA?: boolean; maxResolutionInMP?: number },
) => { width: number; height: number; data: Uint8Array };

/** Sizes the install manifest asks for. Each file is a square PNG of that many pixels. */
export const INSTALL_ICON_SIZES = [180, 192, 512] as const;

export type InstallIconSize = (typeof INSTALL_ICON_SIZES)[number];

const BRAND: readonly [number, number, number] = [0x1f, 0x5f, 0x8b];
const WHITE: readonly [number, number, number] = [0xff, 0xff, 0xff];

export function isInstallIconSize(value: number): value is InstallIconSize {
  return (INSTALL_ICON_SIZES as readonly number[]).includes(value);
}

interface Rgba {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * A square PNG the browser can install. The logo is fitted whole inside the
 * square, on white, so a wide or tall mark is not cropped into a letter.
 * A logo this process cannot read becomes the shared heart. Windows Chrome
 * still installs a letter instead of this image; that is a known bug
 * (docs/design/ngo-app-ui-design.md, Installable and store app).
 */
export function squareInstallIcon(body: Buffer, mime: string, size: InstallIconSize): Buffer {
  const logo = decodeLogo(body, mime);
  return encodePng(logo ? contain(logo, size) : heart(size));
}

function decodeLogo(body: Buffer, mime: string): Rgba | null {
  try {
    const type = mime.trim().toLowerCase();
    if (type === 'image/png' || (body.length >= 8 && body[0] === 0x89 && body[1] === 0x50)) return decodePng(body);
    if (type === 'image/jpeg' || type === 'image/jpg' || (body.length >= 2 && body[0] === 0xff && body[1] === 0xd8)) {
      const raw = decodeJpeg(body, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 16 });
      if (!raw.width || !raw.height) return null;
      return { width: raw.width, height: raw.height, pixels: raw.data };
    }
    return null;
  } catch {
    return null;
  }
}

/** Fits the whole logo in the middle 80%, which is the maskable safe zone. */
function contain(logo: Rgba, size: number): Rgba {
  const inner = Math.max(1, Math.round(size * 0.8));
  const scale = Math.min(inner / logo.width, inner / logo.height);
  const dw = Math.max(1, Math.round(logo.width * scale));
  const dh = Math.max(1, Math.round(logo.height * scale));
  const ox = Math.floor((size - dw) / 2);
  const oy = Math.floor((size - dh) / 2);
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = WHITE[0];
    pixels[i + 1] = WHITE[1];
    pixels[i + 2] = WHITE[2];
    pixels[i + 3] = 255;
  }
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(logo.height - 1, Math.floor(((y + 0.5) * logo.height) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(logo.width - 1, Math.floor(((x + 0.5) * logo.width) / dw));
      const from = (sy * logo.width + sx) * 4;
      const alpha = logo.pixels[from + 3] / 255;
      const to = ((oy + y) * size + ox + x) * 4;
      pixels[to] = Math.round(logo.pixels[from] * alpha + WHITE[0] * (1 - alpha));
      pixels[to + 1] = Math.round(logo.pixels[from + 1] * alpha + WHITE[1] * (1 - alpha));
      pixels[to + 2] = Math.round(logo.pixels[from + 2] * alpha + WHITE[2] * (1 - alpha));
      pixels[to + 3] = 255;
    }
  }
  return { width: size, height: size, pixels };
}

/** The shared heart, for an organisation that has no logo the browser can draw. */
function heart(size: number): Rgba {
  const pixels = new Uint8Array(size * size * 4);
  const samples = 4;
  const corner = size === 512 || size === 192 ? 0.44 : 0;
  const mark = size === 512 ? (corner === 0 ? 0.4 : 0.5) : size === 192 ? 0.5 : 0.46;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0;
      const rgb = [0, 0, 0];
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = ((px + (sx + 0.5) / samples) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / samples) / size) * 2 - 1;
          if (!inSquare(x, y, corner)) continue;
          const colour = inHeart(x, y, mark) ? WHITE : BRAND;
          covered++;
          rgb[0] += colour[0];
          rgb[1] += colour[1];
          rgb[2] += colour[2];
        }
      }
      const at = (py * size + px) * 4;
      const n = samples * samples;
      pixels[at] = covered ? Math.round(rgb[0] / covered) : 0;
      pixels[at + 1] = covered ? Math.round(rgb[1] / covered) : 0;
      pixels[at + 2] = covered ? Math.round(rgb[2] / covered) : 0;
      pixels[at + 3] = Math.round((covered / n) * 255);
    }
  }
  return { width: size, height: size, pixels };
}

function inSquare(x: number, y: number, r: number): boolean {
  const dx = Math.max(Math.abs(x) - (1 - r), 0);
  const dy = Math.max(Math.abs(y) - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function inHeart(x: number, y: number, s: number): boolean {
  const hx = x / s;
  const hy = -y / s + 0.125;
  const q = hx * hx + hy * hy - 1;
  return q * q * q - hx * hx * hy * hy * hy <= 0;
}

function decodePng(buf: Buffer): Rgba | null {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const end = pos + 8 + length;
    if (end + 4 > buf.length) return null;
    const data = buf.subarray(pos + 8, end);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = new Uint8Array(data);
    else if (type === 'tRNS') transparency = new Uint8Array(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos = end + 4;
  }
  if (!width || !height || width > 4096 || height > 4096 || bitDepth !== 8 || interlace !== 0 || idat.length === 0) return null;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) return null;
  const rows = unfilter(raw, height, stride, channels);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const i = x * channels;
      if (colorType === 6) {
        pixels.set(row.subarray(i, i + 4), at);
      } else if (colorType === 2) {
        pixels.set(row.subarray(i, i + 3), at);
        pixels[at + 3] = 255;
      } else if (colorType === 4) {
        pixels[at] = pixels[at + 1] = pixels[at + 2] = row[i];
        pixels[at + 3] = row[i + 1];
      } else if (colorType === 0) {
        pixels[at] = pixels[at + 1] = pixels[at + 2] = row[i];
        pixels[at + 3] = 255;
      } else if (colorType === 3 && palette) {
        const index = row[i];
        const p = index * 3;
        pixels[at] = palette[p] ?? 0;
        pixels[at + 1] = palette[p + 1] ?? 0;
        pixels[at + 2] = palette[p + 2] ?? 0;
        pixels[at + 3] = transparency ? (transparency[index] ?? 255) : 255;
      } else return null;
    }
  }
  return { width, height, pixels };
}

function unfilter(raw: Buffer, height: number, stride: number, channels: number): Uint8Array[] {
  const rows: Uint8Array[] = [];
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset];
    offset += 1;
    const row = new Uint8Array(raw.subarray(offset, offset + stride));
    offset += stride;
    const prev = rows[y - 1];
    if (filter === 1 || filter === 3 || filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? row[i - channels] : 0;
        const up = prev ? prev[i] : 0;
        const ul = prev && i >= channels ? prev[i - channels] : 0;
        if (filter === 1) row[i] = (row[i] + left) & 255;
        else if (filter === 3) row[i] = (row[i] + Math.floor((left + up) / 2)) & 255;
        else row[i] = (row[i] + paeth(left, up, ul)) & 255;
      }
    } else if (filter === 2 && prev) {
      for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 255;
    }
    rows.push(row);
  }
  return rows;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodePng(image: Rgba): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.pixels.buffer, image.pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
