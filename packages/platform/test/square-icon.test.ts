import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { squareInstallIcon } from '../src/application/organisations/square-icon.js';

/** A wide 4×2 red PNG. The install icon must come back square. */
function widePng(): Buffer {
  const raw = Buffer.alloc(2 * (1 + 4 * 4));
  for (let y = 0; y < 2; y++) {
    const row = y * (1 + 16);
    raw[row] = 0;
    for (let x = 0; x < 4; x++) {
      const at = row + 1 + x * 4;
      raw[at] = 200;
      raw[at + 1] = 20;
      raw[at + 2] = 20;
      raw[at + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('install icon', () => {
  it('fits a wide logo into a square PNG', () => {
    const icon = squareInstallIcon(widePng(), 'image/png', 192);
    expect(pngSize(icon)).toEqual({ width: 192, height: 192 });
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('uses the shared heart when the logo cannot be drawn', () => {
    const icon = squareInstallIcon(Buffer.from('not an image'), 'image/png', 180);
    expect(pngSize(icon)).toEqual({ width: 180, height: 180 });
  });
});
