import { asSignature, fileIds, isSigned, signedLine } from './files';
import { formatDate, formatMoney, formatNumber, t } from '../i18n/i18n';
import { locationText } from './location';
import type { FieldDef, FieldType, RecordTypeBody } from '../models';
import { richTextToPlain } from './rich-text';

/** Field types that do not fit a list column. */
const NOT_COLUMNS = new Set<FieldType>(['longText', 'richText', 'file', 'signature', 'location', 'multiChoice']);

export function displayValue(field: FieldDef, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (field.type) {
    case 'money':
      return typeof value === 'number' ? formatMoney(value) : String(value);
    case 'boolean':
      return value === true ? t('ui.common.yes') : t('ui.common.no');
    case 'choice':
      return field.choices?.find((c) => c.value === value)?.label ?? String(value);
    case 'date':
      return formatDate(String(value));
    case 'person':
      return value && typeof value === 'object' && 'name' in value ? String(value.name) : value === 'me' ? t('ui.records.assignedToMe') : String(value);
    case 'multiChoice':
      return Array.isArray(value) && value.length ? value.map((v) => field.choices?.find((c) => c.value === v)?.label ?? String(v)).join(', ') : '—';
    case 'file': {
      const n = fileIds(value).length;
      return n ? `📎 ${formatNumber(n)}` : '—';
    }
    case 'location':
      return locationText(value);
    case 'signature': {
      const s = asSignature(value);
      return s && isSigned(s) ? signedLine(s) : '—';
    }
    case 'richText':
      return typeof value === 'string' ? richTextToPlain(value) || '—' : '—';
    default:
      return String(value);
  }
}

/** Columns for list pages: the title field, then up to three short required or searchable fields. */
export function listColumns(type: RecordTypeBody, max = 4): FieldDef[] {
  const title = type.fields.find((f) => f.key === type.titleField);
  const rest = type.fields.filter(
    (f) => f !== title && !NOT_COLUMNS.has(f.type) && !f.sensitive && (f.required || f.searchable || f.type === 'money'),
  );
  return [...(title ? [title] : []), ...rest].slice(0, max);
}

/** camelCase key from a label, e.g. "Donor PAN no." -> "donorPanNo". */
export function toKey(label: string): string {
  const words = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('');
  if (!key) return '';
  return /^[a-z]/.test(key) ? key.slice(0, 63) : `f${key}`.slice(0, 63);
}

/** Maps API issue paths like "/amount" to field keys. */
export function issuesByField(issues: { path: string; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.replace(/^\//, '').split('/')[0] ?? '';
    if (key && !out[key]) out[key] = i.message;
  }
  return out;
}
