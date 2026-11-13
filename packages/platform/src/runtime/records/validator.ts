import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { isMoney } from '../../domain/money.js';
import type { FieldIssue } from '@onengo/kernel/errors';
import type { FieldDef, RecordTypeDef } from '../definitions/types.js';

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv, ['date', 'date-time', 'email', 'uuid']);

export const RICH_TEXT_MAX = 50_000;
const MAX_FILES = 20;

export function fieldSchema(f: FieldDef): Record<string, unknown> {
  switch (f.type) {
    case 'multiChoice':
      return { type: 'array', uniqueItems: true, items: { type: 'string', enum: (f.choices ?? []).map((c) => c.value) } };
    case 'file':
      return f.multiple
        ? { type: 'array', uniqueItems: true, maxItems: MAX_FILES, items: { type: 'string', format: 'uuid' } }
        : { type: 'string', format: 'uuid' };
    case 'location':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          accuracy: { type: 'number', minimum: 0 },
          label: { type: 'string', maxLength: 200 },
        },
      };
    case 'signature':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['file'],
        properties: {
          file: { type: 'string', format: 'uuid' },
          signedAt: { type: 'string', format: 'date-time' },
          signedBy: { type: 'string', maxLength: 200 },
        },
      };
    case 'richText':
      return { type: 'string', maxLength: Math.min(f.maxLength ?? RICH_TEXT_MAX, RICH_TEXT_MAX) };
    case 'text':
      return { type: 'string', maxLength: f.maxLength ?? 500 };
    case 'longText':
      return { type: 'string', maxLength: f.maxLength ?? 20_000 };
    case 'number':
    case 'money':
      return {
        type: 'number',
        ...(f.min !== undefined ? { minimum: f.min } : {}),
        ...(f.max !== undefined ? { maximum: f.max } : {}),
      };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'boolean':
      return { type: 'boolean' };
    case 'choice':
      return { type: 'string', enum: (f.choices ?? []).map((c) => c.value) };
    case 'email':
      return { type: 'string', format: 'email', maxLength: 254 };
    case 'phone':
      return { type: 'string', pattern: '^\\+?[0-9 ()-]{6,20}$' };
    case 'reference':
    case 'person':
      return { type: 'string', format: 'uuid' };
  }
}

const FORMAT_MESSAGE: Record<string, string> = {
  email: 'Enter a valid email address, like name@example.org.',
  date: 'Enter a valid date, like 2026-04-01.',
  'date-time': 'Enter a valid date and time.',
};

const num = (n: unknown): string => String(n).replace('-', '−');
const PART: Record<string, string> = { lat: 'latitude', lng: 'longitude', file: 'file', accuracy: 'accuracy' };
const part = (key: unknown): string => PART[String(key)] ?? String(key);

/**
 * What the validator found, as sentences a person can act on. The validator's
 * own wording ("must match pattern ^\+?[0-9 ()-]{6,20}$") names the rule, not
 * the problem, so each kind of finding is described here instead. A message
 * names its field, or says what to enter, so it reads on its own.
 */
export function recordIssues(type: RecordTypeDef, errors: ErrorObject[] | null | undefined): FieldIssue[] {
  return (errors ?? []).map((e) => {
    const parts = e.instancePath.split('/').filter(Boolean);
    const field = type.fields.find((f) => f.key === parts[0]);
    const label = field?.label ?? 'This value';
    const sub = parts[1];
    const p = e.params as Record<string, unknown>;
    let message: string;
    switch (e.keyword) {
      case 'format':
        message = FORMAT_MESSAGE[String(p.format)] ?? (p.format === 'uuid' ? `Choose a valid option for ${label}.` : `${label} is not in the expected format.`);
        break;
      case 'pattern':
        message = field?.type === 'phone' ? 'Enter a valid phone number, like +91 98765 43210.' : (field?.patternMessage ?? `${label} is not in the expected format.`);
        break;
      case 'maxLength':
        message = `Use at most ${num(p.limit)} characters for ${label}.`;
        break;
      case 'minimum':
        message = sub ? `${label}: the ${part(sub)} must be at least ${num(p.limit)}.` : `${label} must be at least ${num(p.limit)}.`;
        break;
      case 'maximum':
        message = sub ? `${label}: the ${part(sub)} must be at most ${num(p.limit)}.` : `${label} must be at most ${num(p.limit)}.`;
        break;
      case 'type':
        message =
          p.type === 'number' ? `${label} must be a number.` : p.type === 'string' ? `${label} must be text.` : p.type === 'boolean' ? `Choose yes or no for ${label}.` : `${label} is not in the expected form.`;
        break;
      case 'enum':
        message = `Choose one of the available options for ${label}.`;
        break;
      case 'required':
        message = `${label} needs its ${part(p.missingProperty)}.`;
        break;
      case 'uniqueItems':
        message = `${label} lists the same choice more than once.`;
        break;
      case 'maxItems':
        message = `Add at most ${num(p.limit)} items to ${label}.`;
        break;
      case 'additionalProperties':
        message = field ? `${label} has an unexpected “${String(p.additionalProperty)}” part.` : `“${String(p.additionalProperty)}” is not a field of this record.`;
        break;
      default:
        message = `${label} is not valid.`;
    }
    return { path: e.instancePath || '/', message };
  });
}

const cache = new Map<string, ValidateFunction>();

function compile(type: RecordTypeDef, version: number): ValidateFunction {
  // Versions are numbered per organisation, so the same key and version can mean different fields.
  const cacheKey = `${type.key}@${version}:${JSON.stringify(type.fields)}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(type.fields.map((f) => [f.key, fieldSchema(f)])),
  };
  const fn = ajv.compile(schema);
  if (cache.size > 2000) cache.clear();
  cache.set(cacheKey, fn);
  return fn;
}

export function validateRecordData(
  type: RecordTypeDef,
  version: number,
  data: Record<string, unknown>,
  requiredForTransition: string[] = [],
  hidden: ReadonlySet<string> = new Set(),
): FieldIssue[] {
  const fn = compile(type, version);
  const issues = fn(data) ? [] : recordIssues(type, fn.errors);
  for (const f of type.fields) {
    // Required applies only while the field is shown.
    if (f.required && !f.calculated && !f.rollup && !hidden.has(f.key) && data[f.key] === undefined) {
      issues.push({ path: `/${f.key}`, message: 'is required' });
    }
  }
  for (const f of type.fields) {
    const v = data[f.key];
    if (f.type === 'money' && v !== undefined && !isMoney(v)) {
      issues.push({ path: `/${f.key}`, message: 'must be an amount with at most two decimal places' });
    }
    if (f.type === 'location' && v && typeof v === 'object') {
      const { lat, lng } = v as { lat?: unknown; lng?: unknown };
      if ([lat, lng].some((n) => typeof n === 'number' && decimals(n) > 6)) {
        issues.push({ path: `/${f.key}`, message: 'coordinates can have at most six decimal places' });
      }
    }
  }
  for (const key of requiredForTransition) {
    if (data[key] === undefined) issues.push({ path: `/${key}`, message: 'is required for this step' });
  }
  return issues;
}

function decimals(n: number): number {
  const [, frac = '', exp] = /^-?\d+(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(n)) ?? [];
  return Math.max(0, frac.length - Number(exp ?? 0));
}

/** Drops empty values so clearing a field removes it. */
export function normaliseData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}
