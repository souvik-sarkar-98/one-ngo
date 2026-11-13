type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isKeyedArray = (v: unknown): v is Record<string, Json>[] =>
  Array.isArray(v) && v.every((i) => isObject(i) && typeof i.key === 'string');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * JSON merge patch (RFC 7396) with one extension so an NGO can change one field
 * of a shipped definition without restating the whole list:
 *
 * - When both sides are arrays of objects that all have a string `key`, items
 *   merge by key, new keys are appended, and `{ "key": "x", "$delete": true }`
 *   removes an item.
 * - Any other array in the patch replaces the base array.
 * - `null` removes a property.
 */
export function applyExtensionPatch<T>(base: T, patch: unknown): T {
  return merge(base as Json, patch as Json) as T;
}

/**
 * Builds the smallest extension patch that turns `base` into `edited`, in the
 * format the keyed merge above understands: keyed lists merge by `key`,
 * removed items are `{ key, $delete: true }`, removed properties are `null`.
 * Items added to a keyed list are appended after the base items.
 */
export function makePatch(base: unknown, edited: unknown): Json | undefined {
  if (same(base, edited)) return undefined;
  if (isKeyedArray(base) && isKeyedArray(edited)) {
    const out: Record<string, Json>[] = [];
    for (const b of base) {
      const e = edited.find((x) => x.key === b.key);
      if (!e) out.push({ key: b.key!, $delete: true });
      else {
        const p = makePatch(b, e);
        if (p !== undefined) out.push({ ...(p as Record<string, Json>), key: b.key! });
      }
    }
    for (const e of edited) if (!base.some((b) => b.key === e.key)) out.push(e);
    return out;
  }
  if (isObject(base) && isObject(edited)) {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(base)) if (!(k in edited)) out[k] = null;
    for (const [k, v] of Object.entries(edited)) {
      const p = makePatch(base[k], v);
      if (p !== undefined) out[k] = p;
    }
    return out;
  }
  return edited as Json;
}

function merge(base: Json, patch: Json): Json {
  if (isKeyedArray(base) && isKeyedArray(patch)) {
    const out = base.map((i) => structuredClone(i));
    for (const item of patch) {
      const idx = out.findIndex((b) => b.key === item.key);
      if (item.$delete === true) {
        if (idx >= 0) out.splice(idx, 1);
        continue;
      }
      if (idx >= 0) out[idx] = merge(out[idx]!, item) as Record<string, Json>;
      else out.push(stripDirectives(item) as Record<string, Json>);
    }
    return out;
  }
  if (!isObject(patch)) return structuredClone(patch);
  const out: Record<string, Json> = isObject(base) ? structuredClone(base) : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '$delete') continue;
    if (v === null) delete out[k];
    else out[k] = merge(out[k] ?? null, v);
  }
  return out;
}

/**
 * Parts of an extension patch whose targets the older base had and the newer
 * base no longer has, so the patch would silently do something else.
 * Paths name keyed-array items by key, for example `/fields/amount/required`.
 */
export function stalePatchPaths(oldBase: unknown, newBase: unknown, patch: unknown, path = ''): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (isKeyedArray(patch) && isKeyedArray(oldBase)) {
    const now = isKeyedArray(newBase) ? newBase : [];
    for (const item of patch) {
      const at = `${path}/${item.key as string}`;
      const before = oldBase.find((b) => b.key === item.key);
      const after = now.find((b) => b.key === item.key);
      if (after) {
        if (before && item.$delete !== true) out.push(...stalePatchPaths(before, after, item, at));
      } else if (before) {
        out.push({ path: at, message: item.$delete === true ? `removes '${item.key as string}', which the module no longer has` : `changes '${item.key as string}', which the module no longer has` });
      }
    }
    return out;
  }
  if (!isObject(patch) || !isObject(oldBase)) return out;
  const now = isObject(newBase) ? newBase : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '$delete' || k === 'key') continue;
    const had = Object.hasOwn(oldBase, k);
    const has = Object.hasOwn(now, k);
    if (had && !has && (v === null || isObject(v) || isKeyedArray(v))) {
      out.push({ path: `${path}/${k}`, message: v === null ? `removes '${k}', which the module no longer has` : `changes '${k}', which the module no longer has` });
    } else if (had && has) out.push(...stalePatchPaths(oldBase[k], now[k], v, `${path}/${k}`));
  }
  return out;
}

function stripDirectives(v: Json): Json {
  if (Array.isArray(v)) return v.map(stripDirectives);
  if (!isObject(v)) return v;
  const out: Record<string, Json> = {};
  for (const [k, val] of Object.entries(v)) if (k !== '$delete') out[k] = stripDirectives(val);
  return out;
}
