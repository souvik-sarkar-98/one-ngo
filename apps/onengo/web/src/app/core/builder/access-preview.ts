import type { FieldDef, ListViewDef, RecordView, RuntimeAction, RuntimeRecordType, RuntimeWorkflow } from '../models';
import { detailSections, recordTitle, rowModel, type DetailSection } from '../records/record/present';
import { resolveListSpec, type ChipSpec } from '../records/spec';
import type { RowView } from '../rows';
import { elementName } from './access-map';
import type { AccessMapElement } from './http-access';

/** What a person without a field's read permission sees, as on the server. */
export const MASK = '***';

/** The list and record panel of one record type as a role sees them. */
export interface PreviewModel {
  title: string;
  /** The role sees the record type at all. */
  visible: boolean;
  chips: ChipSpec[];
  rows: RowView[];
  panelTitle: string;
  sections: DetailSection[];
  canCreate: boolean;
  /** Labels of the workflow steps and record actions the role may run. */
  steps: string[];
}

const MONEY = [1500, 5000, 750];

function sampleValue(f: FieldDef, i: number): unknown {
  if (f.calculated) return null;
  switch (f.type) {
    case 'number':
      return (i + 1) * 10;
    case 'money':
      return MONEY[i % MONEY.length];
    case 'date':
      return `2026-04-${String(i + 1).padStart(2, '0')}`;
    case 'boolean':
      return i % 2 === 0;
    case 'choice':
      return f.choices?.length ? f.choices[i % f.choices.length]!.value : null;
    case 'email':
      return `person${i + 1}@example.org`;
    case 'phone':
      return `9876543${String(210 + i)}`;
    case 'reference':
    case 'person':
      return null;
    default:
      return `${f.label} ${i + 1}`;
  }
}

/** A few made-up records of a record type, one value per field, in its workflow's states. */
export function sampleRecords(type: RuntimeRecordType, workflow?: RuntimeWorkflow, count = 3): RecordView[] {
  const prefix = type.key.slice(0, 3).toUpperCase();
  return Array.from({ length: count }, (_, i) => ({
    id: `sample-${i + 1}`,
    type: type.key,
    number: type.numbering ? `${prefix}/${String(i + 1).padStart(5, '0')}` : null,
    status: workflow ? (i === 0 ? workflow.initial : (workflow.states[i % workflow.states.length]?.key ?? workflow.initial)) : null,
    ...(workflow && { workflow: workflow.key }),
    version: 1,
    schemaVersion: 1,
    data: Object.fromEntries(type.fields.map((f) => [f.key, sampleValue(f, i)])),
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-04-01T09:00:00.000Z',
  }));
}

const indexIn = (path: string | undefined, re: RegExp): number => {
  const m = path ? re.exec(path) : null;
  return m ? Number(m[1]) : -1;
};

/**
 * The real list and record panel models with a role's view of the access map
 * applied: fields it may not see masked, chips and sections it may not see
 * left out, and only the steps and actions it may run.
 */
export function rolePreview(input: {
  type: RuntimeRecordType;
  workflow?: RuntimeWorkflow;
  workflows?: RuntimeWorkflow[];
  view?: ListViewDef;
  actions?: RuntimeAction[];
  elements: AccessMapElement[];
  records?: RecordView[];
}): PreviewModel {
  const { type, view } = input;
  const mine = input.elements.filter((e) => e.recordType === type.key && e.area === 'records');
  const seen = (kind: AccessMapElement['element'], access?: string) => mine.filter((e) => e.element === kind && (!access || e.access === access));
  const visible = seen('recordType', 'see').some((e) => e.visible);
  const masked = new Set(
    seen('field', 'see')
      .filter((e) => !e.visible)
      .map((e) => type.fields[indexIn(e.definition?.path, /^\/fields\/(\d+)\//)]?.key)
      .filter((k): k is string => !!k),
  );
  const fromView = (kind: 'chip' | 'section') => seen(kind).filter((e) => !e.visible && e.definition?.kind === 'listView' && e.definition.key === view?.key);
  const hiddenChips = new Set(fromView('chip').map((e) => view?.chips?.[indexIn(e.definition?.path, /^\/chips\/(\d+)\//)]?.id));
  const hiddenSections = new Set(
    fromView('section').map((e) => {
      const i = indexIn(e.definition?.path, /^\/detail\/sections\/(\d+)\//);
      return view?.detail?.sections[i]?.id ?? `section${i}`;
    }),
  );
  const shown: RuntimeRecordType = {
    ...type,
    fields: type.fields.map((f): FieldDef => (masked.has(f.key) ? { key: f.key, label: f.label, type: 'text', visibleWhen: f.visibleWhen } : f)),
  };
  const spec = resolveListSpec(shown, input.workflow, view, { workflows: input.workflows, actions: input.actions });
  const records = (input.records ?? sampleRecords(type, input.workflow)).map((r) => ({
    ...r,
    data: Object.fromEntries(Object.entries(r.data).map(([k, v]) => [k, masked.has(k) ? MASK : v])),
  }));
  const sections = spec.sections.filter((s) => !hiddenSections.has(s.id));
  const first = records[0];
  return {
    title: spec.title,
    visible,
    chips: spec.chips.filter((c) => !hiddenChips.has(c.id)),
    rows: records.map((r) => {
      const { record: _, ...row } = rowModel(spec, r);
      return { ...row, actions: [] };
    }),
    panelTitle: first ? recordTitle(spec, first) : spec.title,
    sections: first ? detailSections({ ...spec, sections }, first, [], { id: '', roles: [] }) : [],
    canCreate: seen('recordType', 'create').some((e) => e.visible),
    steps: [...seen('step'), ...seen('action')].filter((e) => e.visible).map(elementName),
  };
}
