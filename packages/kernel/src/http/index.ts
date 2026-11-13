const MAX_KEY_LENGTH = 200;
const EVICTION_SCAN = 64;
const OVERFLOW_KEY = '\u0000overflow';

/** Bounded, fixed-window, in-memory rate limiter. */
export class MemoryRateLimiter {
  private readonly windows = new Map<string, { start: number; hits: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  hit(rawKey: string, now = Date.now()): boolean {
    let key = rawKey.length > MAX_KEY_LENGTH ? rawKey.slice(0, MAX_KEY_LENGTH) : rawKey;
    const current = this.windows.get(key);
    if (current && now - current.start < this.windowMs) return ++current.hits <= this.limit;
    if (current) this.windows.delete(key);
    else if (this.windows.size >= this.maxKeys && !this.makeRoom(now)) {
      key = OVERFLOW_KEY;
      const overflow = this.windows.get(key);
      if (overflow && now - overflow.start < this.windowMs) return ++overflow.hits <= this.limit;
      this.windows.delete(key);
    }
    this.windows.set(key, { start: now, hits: 1 });
    return true;
  }

  get size(): number {
    return this.windows.size;
  }

  private makeRoom(now: number): boolean {
    for (const [key, window] of this.windows) {
      if (now - window.start < this.windowMs) break;
      this.windows.delete(key);
    }
    if (this.windows.size < this.maxKeys) return true;
    let scanned = 0;
    for (const [key, window] of this.windows) {
      if (++scanned > EVICTION_SCAN) break;
      if (key !== OVERFLOW_KEY && window.hits <= this.limit) {
        this.windows.delete(key);
        return true;
      }
    }
    return false;
  }
}

export function parseJsonBody(text: string, maximumBytes = 1_000_000): unknown {
  if (Buffer.byteLength(text) > maximumBytes) throw new TypeError('JSON body is too large.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Request body must be valid JSON.');
  }
}

export const opensInline = (mime: string): boolean => mime.startsWith('image/') || mime === 'application/pdf';
