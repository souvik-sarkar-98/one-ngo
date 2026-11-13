import type { FieldKeyRing } from './ports/field-key-ring.js';
import { isStoredEncrypted } from '../definitions/field-permissions.js';
import type { FieldDef, RecordTypeDef } from '../definitions/types.js';

/** A record's data as written: sensitive values sealed, with the keyed hashes of the unique ones by field key. */
export interface StoredData {
  data: Record<string, unknown>;
  index: Record<string, string>;
}

/** The stored form of a sealed value: enc:v1:<key id>:<payload>. Written by the key ring in infrastructure; this must match. */
const SEALED = /^enc:v1:([0-9a-f]{8}):([A-Za-z0-9_-]+)$/;
const isSealed = (value: unknown): value is string => typeof value === 'string' && SEALED.test(value);
const sealedKeyOf = (value: string): string | undefined => SEALED.exec(value)?.[1];

const empty = (v: unknown) => v === undefined || v === null || v === '';
const contextOf = (type: Pick<RecordTypeDef, 'key'>, f: FieldDef) => `${type.key}.${f.key}`;
const sameIndex = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** What a unique check compares, as the plain-text check does: numbers by value, text ignoring case. */
const indexInput = (type: Pick<RecordTypeDef, 'key'>, f: FieldDef, value: unknown) =>
  `${type.key}\u0000${f.key}\u0000${f.type === 'number' ? String(Number(value)) : String(value).toLowerCase()}`;

/**
 * Encrypts the values of sensitive fields as a save writes them and decrypts
 * them where records are read, so every stage, script, view and export in
 * between sees plain values. Unique sensitive fields also keep a keyed hash
 * of the value, which unique checks and the managed unique index compare.
 */
export class SensitiveFields {
  constructor(private readonly ring: FieldKeyRing | null) {}

  /** For processes that never read or write sensitive values; any attempt fails. */
  static withoutKeys(): SensitiveFields {
    return new SensitiveFields(null);
  }

  seal(type: RecordTypeDef, data: Record<string, unknown>): StoredData {
    const out = { ...data };
    const index: Record<string, string> = {};
    for (const f of type.fields) {
      if (!isStoredEncrypted(f) || empty(out[f.key])) continue;
      const ring = this.keys();
      if (f.unique) index[f.key] = ring.indexes(indexInput(type, f, out[f.key]))[0]!;
      out[f.key] = ring.seal(JSON.stringify(out[f.key]), contextOf(type, f));
    }
    return { data: out, index };
  }

  /**
   * The data with sealed values opened. Values stored before their field was
   * encrypted read as they are; a field that is no longer sensitive still
   * opens until the re-encryption job rewrites it.
   */
  open(type: RecordTypeDef | undefined, data: Record<string, unknown>): Record<string, unknown> {
    if (!type) return data;
    let out: Record<string, unknown> | undefined;
    for (const f of type.fields) {
      const v = data[f.key];
      if (!isSealed(v)) continue;
      (out ??= { ...data })[f.key] = this.openValue(type, f, v);
    }
    return out ?? data;
  }

  openValue(type: RecordTypeDef, f: FieldDef, value: unknown): unknown {
    if (!isSealed(value)) return value;
    try {
      return JSON.parse(this.keys().open(value, contextOf(type, f))) as unknown;
    } catch (error) {
      if (isStoredEncrypted(f)) throw error;
      return value;
    }
  }

  /** The keyed hashes a stored `value` of unique field `f` may have, one per key. */
  lookups(type: RecordTypeDef, f: FieldDef, value: unknown): string[] {
    return this.keys().indexes(indexInput(type, f, value));
  }

  /**
   * The stored form the definition and the current key call for, or null when
   * the stored data already has it: plain sensitive values are sealed, values
   * under an older key are sealed again, and fields that are no longer
   * sensitive are opened.
   */
  rewrite(type: RecordTypeDef, stored: Record<string, unknown>, index: Record<string, string>): StoredData | null {
    const plain = this.open(type, stored);
    const next = this.seal(type, plain);
    const current = this.keys().currentId;
    const stale = type.fields.some((f) => {
      const v = stored[f.key];
      if (!isStoredEncrypted(f)) return plain[f.key] !== v;
      return !empty(v) && !(isSealed(v) && sealedKeyOf(v) === current);
    });
    return stale || !sameIndex(index, next.index) ? next : null;
  }

  private keys(): FieldKeyRing {
    if (!this.ring) throw new Error('Sensitive values cannot be read or written without ENCRYPTION_KEY.');
    return this.ring;
  }
}
