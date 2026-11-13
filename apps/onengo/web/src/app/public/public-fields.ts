import type { CfFieldDef, CfFieldType } from '../ui/cf-types';

/** A field as the public form API describes it. */
export interface PublicField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  help?: string;
  placeholder?: string;
  choices?: { value: string; label: string }[];
  referenceType?: string;
}

const TYPES: Record<string, CfFieldType> = {
  text: 'text',
  longText: 'textarea',
  number: 'number',
  money: 'number',
  date: 'date',
  boolean: 'boolean',
  choice: 'select',
  multiChoice: 'multiselect',
  email: 'email',
  phone: 'text',
  location: 'location',
  richText: 'richText',
};

/** Fields the cards form can draw. A catalogue reference is drawn by the screen. */
export function publicControls(fields: PublicField[]): CfFieldDef[] {
  return fields.flatMap((field) => {
    const type = TYPES[field.type];
    if (!type || field.referenceType) return [];
    return [{
      key: field.key,
      label: field.label,
      type,
      required: field.required,
      readOnly: false,
      options: (field.choices ?? []).map((choice) => ({ key: choice.value, label: choice.label })),
      hint: field.help,
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    }];
  });
}
