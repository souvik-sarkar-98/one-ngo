import { validationFailed } from '@onengo/kernel/errors';

export interface Page {
  limit: number;
  offset: number;
}

export function pageOf(limit: unknown, offset: unknown, max = 200, fallback = 50): Page {
  const l = Math.trunc(Number(limit));
  const o = Math.trunc(Number(offset));
  return {
    limit: Number.isFinite(l) && l >= 1 ? Math.min(l, max) : fallback,
    offset: Number.isFinite(o) && o >= 0 ? o : 0,
  };
}

/** A query parameter sent once, several times (`role=a&role=b`) or comma-separated, as a list. */
export function listOf(value: unknown, max = 50): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const all = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
  return all.length ? [...new Set(all)].slice(0, max) : undefined;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw validationFailed(`${path} must be one of ${allowed.join(', ')}.`, [{ path, message: `One of ${allowed.join(', ')}.` }]);
  }
  return value as T;
}

export function allOf<T extends string>(values: string[] | undefined, allowed: readonly T[], path: string): T[] | undefined {
  values?.forEach((v) => oneOf(v, allowed, path));
  return values as T[] | undefined;
}

/** A calendar date (YYYY-MM-DD). */
export function dateOf(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw validationFailed(`${path} must be a date like 2026-04-01.`, [{ path, message: 'A date like 2026-04-01.' }]);
  }
  return text;
}

/** Text for `like`, with its wildcards taken literally (`escape '\'`). */
export function likePattern(text: string): string {
  return `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
