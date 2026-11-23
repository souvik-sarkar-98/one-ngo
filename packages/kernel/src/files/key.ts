const KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/** A storage key is slash-separated segments of letters, digits, `_` and `-`. */
export function storageKey(key: string): string {
  if (!KEY.test(key)) throw new Error(`Invalid storage key '${key}'.`);
  return key;
}
