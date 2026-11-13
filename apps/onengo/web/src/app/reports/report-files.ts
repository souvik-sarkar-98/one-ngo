import type { FormValues } from '../core/records/record/forms';
import type { CfFieldDef } from '../ui/cf-types';

export type ReportFormat = 'pdf' | 'excel';

export interface ReportParameter {
  key: string;
  label: string;
  type: 'text' | 'number' | 'money' | 'date' | 'boolean' | 'choice';
  required?: boolean;
  choices?: { value: string; label: string }[];
}

export type ParamValue = string | number | boolean;

/** The parameter panel's fields, as the record create panel draws them. */
export function parameterFields(parameters: readonly ReportParameter[]): CfFieldDef[] {
  return parameters.map((p) => ({
    key: p.key,
    label: p.label,
    type: p.type === 'boolean' ? 'boolean' : p.type === 'choice' ? 'select' : p.type === 'date' ? 'date' : p.type === 'number' || p.type === 'money' ? 'number' : 'text',
    required: !!p.required,
    readOnly: false,
    options: (p.choices ?? []).map((c) => ({ key: c.value, label: c.label })),
  }));
}

/** Panel values as the report reads them. Blank values are left out. */
export function parameterValues(parameters: readonly ReportParameter[], values: FormValues): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of parameters) {
    const value = values[p.key];
    if (p.type === 'boolean') {
      if (value === true) out[p.key] = true;
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') continue;
    out[p.key] = p.type === 'number' || p.type === 'money' ? Number(value) : value;
  }
  return out;
}

/** Required parameters with no value, by key. */
export function missingParameters(parameters: readonly ReportParameter[], values: FormValues, message: string): Record<string, string> {
  const given = parameterValues(parameters, values);
  return Object.fromEntries(parameters.filter((p) => p.required && p.type !== 'boolean' && !(p.key in given)).map((p) => [p.key, message]));
}

/** Parameter values for an address, so Back from the preview reopens the panel with them. */
export function parameterQuery(params: Record<string, ParamValue>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

/** Panel values read back from an address. */
export function valuesFromQuery(parameters: readonly ReportParameter[], get: (name: string) => string | null): FormValues {
  const out: FormValues = {};
  for (const p of parameters) {
    const given = get(p.key);
    if (given !== null) out[p.key] = p.type === 'boolean' ? given === 'true' : given;
  }
  return out;
}

/** Parameter values read from an address as the server expects them. */
export function paramsFromQuery(parameters: readonly ReportParameter[], get: (name: string) => string | null): Record<string, ParamValue> {
  return parameterValues(parameters, valuesFromQuery(parameters, get));
}

/** One line for a published file: each parameter in order, a choice by its label and a date by its label and day. */
export function parameterSummary(parameters: readonly ReportParameter[], params: Record<string, unknown>, day: (iso: string) => string): string {
  const parts: string[] = [];
  for (const p of parameters) {
    const value = params[p.key];
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (p.type === 'boolean') parts.push(p.label);
    else if (p.type === 'choice') parts.push(p.choices?.find((c) => c.value === value)?.label ?? String(value));
    else if (p.type === 'date' && typeof value === 'string') parts.push(`${p.label} ${day(value)}`);
    else parts.push(String(value));
  }
  return parts.join(' · ');
}

/** A date as the lists show it, for example 5 Nov 2026. */
export function shortDate(iso: string): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
