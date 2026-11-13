import type { UploadTarget } from '../core/fields/files';
import { t } from '../core/i18n/i18n';
import type { FileKind } from '../core/models';
import type { FieldModel } from '../core/records/record/forms';
import type { FilterSpec } from '../core/records/spec';
import type { Suggestion, SuggestionSource } from '../core/ui-logic/autocomplete';

export type CfFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'boolean'
  | 'select'
  | 'multiselect'
  | 'email'
  | 'date_range'
  | 'picker'
  | 'file'
  | 'location'
  | 'signature'
  | 'richText';

/** How a reference or person field searches, what it shows for its value, and what choosing or clearing does. */
export interface PickerBinding {
  source: SuggestionSource;
  text: string;
  choose(option: Suggestion): void;
  clear(): void;
}

/** A field as the cards forms draw it. Date ranges read and write `<key>From` / `<key>To`. */
export interface CfFieldDef {
  key: string;
  label: string;
  type: CfFieldType;
  required: boolean;
  readOnly: boolean;
  options: { key: string; label: string }[];
  hint?: string;
  /** Grey example text shown while the control is empty. */
  placeholder?: string;
  /** Pickers without one cannot search, e.g. the person cannot read the referenced type. */
  picker?: PickerBinding;
  /** Text fields: the most characters allowed. */
  maxLength?: number;
  /** File fields. */
  multiple?: boolean;
  accept?: FileKind[];
  maxSizeMb?: number;
  /** File and signature fields: where uploads go. */
  upload?: UploadTarget;
  /** Location fields: false hides "Type coordinates", leaving only the device location. */
  typedCoordinates?: false;
  /** Signature fields: show the signer's name box. */
  typedName?: true;
}

const TYPES: Record<FieldModel['kind'], CfFieldType> = {
  text: 'text',
  longText: 'textarea',
  number: 'number',
  money: 'number',
  date: 'date',
  boolean: 'boolean',
  choice: 'select',
  email: 'email',
  phone: 'text',
  reference: 'picker',
  person: 'picker',
  multiChoice: 'multiselect',
  file: 'file',
  location: 'location',
  signature: 'signature',
  richText: 'richText',
};

export function cfField(f: FieldModel): CfFieldDef {
  return {
    key: f.key,
    label: f.label,
    type: TYPES[f.kind],
    required: f.required,
    readOnly: f.readOnly,
    options: f.options.map((o) => ({ key: o.value, label: o.label })),
    hint: f.help,
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.maxLength ? { maxLength: f.maxLength } : {}),
    ...(f.kind === 'file' ? { multiple: !!f.multiple, accept: f.accept, maxSizeMb: f.maxSizeMb } : {}),
    ...(f.upload ? { upload: f.upload } : {}),
    ...(f.typedCoordinates === false ? { typedCoordinates: false as const } : {}),
    ...(f.typedName ? { typedName: true as const } : {}),
  };
}

/** The filter sheet's fields, as the list toolkit laid them out. */
export function filterFields(specs: FilterSpec[]): CfFieldDef[] {
  const base = (s: FilterSpec, extra: Partial<CfFieldDef>): CfFieldDef => ({
    key: s.field.key,
    label: s.field.label,
    type: 'text',
    required: false,
    readOnly: false,
    options: (s.field.choices ?? []).map((c) => ({ key: c.value, label: c.label })),
    hint: s.field.help,
    ...extra,
  });
  return specs.flatMap((s): CfFieldDef[] => {
    if (s.kind === 'list') return [base(s, { type: 'multiselect' })];
    if (s.kind === 'flag')
      return [
        base(s, {
          type: 'select',
          options: [
            { key: 'yes', label: t('ui.common.yes') },
            { key: 'no', label: t('ui.common.no') },
          ],
        }),
      ];
    if (s.kind === 'dateRange') return [base(s, { type: 'date_range' })];
    if (s.kind === 'range')
      return [
        base(s, { key: `${s.field.key}From`, label: t('ui.records.rangeFrom', { field: s.field.label }), type: 'number' }),
        base(s, { key: `${s.field.key}To`, label: t('ui.records.rangeTo', { field: s.field.label }), type: 'number' }),
      ];
    return [base(s, {})];
  });
}
