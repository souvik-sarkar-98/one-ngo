/** The keys sensitive record values are sealed with; the cryptography behind it is infrastructure. */
export interface FieldKeyRing {
  readonly currentId: string;
  /** `context` binds the value to where it is stored; opening it elsewhere fails. */
  seal(plaintext: string, context: string): string;
  open(value: string, context: string): string;
  /** Keyed hashes of `input` under every key, the current key's first. */
  indexes(input: string): string[];
}
