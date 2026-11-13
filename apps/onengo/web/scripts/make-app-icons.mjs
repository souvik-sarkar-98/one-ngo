// Draws the installable app's icons into web/public/icons: a white heart on the
// brand colour, as PNGs written with node:zlib alone (no downloads, no packages).
//   node web/scripts/make-app-icons.mjs
// "any" icons are a rounded square; the maskable and Apple icons fill the square
// edge to edge, as the platform cuts its own shape, with the mark kept inside the
// maskable safe zone (the middle 80% circle).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const BRAND = [0x1f, 0x5f, 0x8b];
const MARK = [0xff, 0xff, 0xff];
const SAMPLES = 4;

const ICONS = [
  { file: 'icon-192.png', size: 192, corner: 0.44, mark: 0.5 },
  { file: 'icon-512.png', size: 512, corner: 0.44, mark: 0.5 },
  { file: 'icon-maskable-512.png', size: 512, corner: 0, mark: 0.4 },
  { file: 'apple-touch-icon.png', size: 180, corner: 0, mark: 0.46 },
];

/** Inside a square of half-width 1 with corners rounded by `r`, in coordinates from -1 to 1. */
function inSquare(x, y, r) {
  const dx = Math.max(Math.abs(x) - (1 - r), 0);
  const dy = Math.max(Math.abs(y) - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** Inside the heart (x² + y² − 1)³ ≤ x²y³, scaled by `s` and centred on its bounding box. */
function inHeart(x, y, s) {
  const hx = x / s;
  const hy = -y / s + 0.125;
  const q = hx * hx + hy * hy - 1;
  return q * q * q - hx * hx * hy * hy * hy <= 0;
}

function pixels({ size, corner, mark }) {
  const out = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    for (let px = 0; px < size; px++) {
      let a = 0;
      const rgb = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = ((px + (sx + 0.5) / SAMPLES) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / SAMPLES) / size) * 2 - 1;
          if (!inSquare(x, y, corner)) continue;
          const c = inHeart(x, y, mark) ? MARK : BRAND;
          a++;
          for (let i = 0; i < 3; i++) rgb[i] += c[i];
        }
      }
      const at = row + 1 + px * 4;
      for (let i = 0; i < 3; i++) out[at + i] = a ? Math.round(rgb[i] / a) : 0;
      out[at + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return out;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function png(icon) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(icon.size, 0);
  header.writeUInt32BE(icon.size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels(icon), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');
mkdirSync(dir, { recursive: true });
for (const icon of ICONS) writeFileSync(join(dir, icon.file), png(icon));
console.log(`wrote ${ICONS.map((i) => i.file).join(', ')} to ${dir}`);
