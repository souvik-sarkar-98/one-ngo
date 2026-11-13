import { lowerLabel, t } from '../i18n/i18n';
import type { FieldDef, ListViewDef, RecordView, RuntimeRecordType, RuntimeWorkflow } from '../models';
import { fieldModels, type FieldModel, type Viewer } from '../records/record/forms';
import type { RecordsGateway } from '../records/gateway/gateway';
import { detailSections, type DetailSection } from '../records/record/present';
import { loadRelated, relatedDetail } from '../records/record/related';
import { plainRecordRow } from '../records/list/rows';
import { resolveListSpec, type ListSpec } from '../records/spec';
import type { RowView } from '../rows';
import { memoryGateway, sampleSeed, type MemoryGateways } from '../testing/memory-gateway';

/** A record type as the preview needs it: its published body, its workflows (primary first) and, for related types, its list view. */
export interface PreviewType {
  type: RuntimeRecordType;
  workflows?: RuntimeWorkflow[];
  view?: ListViewDef;
}

export interface PreviewInput {
  /** The list view being edited, unpublished. */
  draft: ListViewDef;
  subject: PreviewType;
  /** Record types that related sections list. */
  others?: PreviewType[];
  /** Records to show: real ones the administrator can see, or `sampleRecords`. */
  records: RecordView[];
  /** Permissions of the person previewed; chips and sections that need one they lack are left out. Everything when not set. */
  permissions?: readonly string[];
}

export interface CreateStepPreview {
  key: string;
  label: string;
  fields: FieldModel[];
}

/** The list, a record panel and the create form of a list view, drawn from memory. */
export interface ListPreview {
  spec: ListSpec;
  gateway: MemoryGateways;
  specOf(type: string): ListSpec | null;
  rows(chip: string, limit?: number): Promise<{ rows: RowView[]; total: number }>;
  /** The record panel of one record; related sections come from `related` when given (real records), else from memory. */
  panel(id: string, related?: RecordsGateway): Promise<DetailSection[]>;
  create(): CreateStepPreview[];
}

const VIEWER: Viewer = { id: 'u1', roles: ['admin'] };
const NAMES = ['Asha Rao', 'Ravi Kumar', 'Meera Iyer', 'Sunita Devi', 'Arjun Reddy', 'Fatima Sheikh'];
const AMOUNTS = [1500, 5000, 750, 2100, 12000, 300];

const holds = (permissions: readonly string[] | undefined, needed: string | undefined) =>
  !needed || !permissions || permissions.includes('*') || permissions.includes(needed);

/** The draft as the person previewed sees it: chips and sections they lack the permission for are left out. */
export function visibleDraft(draft: ListViewDef, permissions?: readonly string[]): ListViewDef {
  if (!permissions) return draft;
  const chips = draft.chips?.filter((c) => holds(permissions, c.permission));
  const sections = draft.detail?.sections.filter((s) => holds(permissions, s.permission));
  return {
    ...draft,
    ...(chips ? { chips } : {}),
    ...(draft.detail ? { detail: { sections: sections ?? [] } } : {}),
  };
}

function sampleValue(f: FieldDef, i: number, title: boolean): unknown {
  const pick = <T>(list: readonly T[]) => list[i % list.length];
  if (title) return pick(NAMES);
  switch (f.type) {
    case 'text':
      return `${f.label} ${i + 1}`;
    case 'longText':
      return f.label;
    case 'number':
      return (i + 1) * 3;
    case 'money':
      return pick(AMOUNTS);
    case 'date':
      return `2026-10-${String(i + 1).padStart(2, '0')}`;
    case 'boolean':
      return i % 2 === 0;
    case 'choice':
      return f.choices?.length ? pick(f.choices)!.value : undefined;
    case 'multiChoice':
      return f.choices?.length ? [pick(f.choices)!.value] : undefined;
    case 'email':
      return `${pick(NAMES)!.split(' ')[0]!.toLowerCase()}@example.org`;
    case 'phone':
      return `98400${String(12340 + i)}`;
    default:
      return undefined;
  }
}

/** Made-up records of a record type, one per state of its primary workflow at least, for when no real records can be read. */
export function sampleRecords(type: RuntimeRecordType, workflow?: RuntimeWorkflow, count = 4): RecordView[] {
  const states = workflow?.states.map((s) => s.key) ?? [];
  const n = Math.max(count, states.length);
  const titleField = type.titleField ?? type.fields.find((f) => f.type === 'text')?.key;
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(Date.UTC(2026, 9, 20 - i, 9)).toISOString();
    const data: Record<string, unknown> = {};
    for (const f of type.fields) {
      if (f.sensitive || f.calculated || f.rollup) continue;
      const v = sampleValue(f, i, f.key === titleField);
      if (v !== undefined) data[f.key] = v;
    }
    return {
      id: `sample-${type.key}-${i + 1}`,
      type: type.key,
      number: type.numbering ? `${type.label.slice(0, 3).toUpperCase()}/${String(i + 1).padStart(5, '0')}` : null,
      status: states.length ? states[i % states.length]! : null,
      ...(workflow ? { workflow: workflow.key } : {}),
      version: 1,
      schemaVersion: type.version,
      data,
      createdAt: at,
      updatedAt: at,
    };
  });
}

/**
 * Puts the draft list view, its record types and the records into an
 * in-memory gateway and draws the list from there, through the same spec,
 * rows and record panel code the app uses. Nothing reaches the server.
 */
export function listPreview(input: PreviewInput): ListPreview {
  const seed = sampleSeed();
  const types = [input.subject, ...(input.others ?? []).filter((o) => o.type.key !== input.subject.type.key)];
  const draft = visibleDraft(input.draft, input.permissions);
  seed.definitions = {
    ...seed.definitions,
    recordTypes: types.map((p) => p.type),
    workflows: Object.fromEntries(types.flatMap((p): [string, RuntimeWorkflow][] => (p.workflows?.[0] ? [[p.type.key, p.workflows[0]]] : []))),
    workflowSets: Object.fromEntries(types.map((p): [string, RuntimeWorkflow[]] => [p.type.key, p.workflows ?? []])),
    listViews: Object.fromEntries([...types.flatMap((p): [string, ListViewDef][] => (p.view ? [[p.type.key, p.view]] : [])), [input.subject.type.key, draft] as [string, ListViewDef]]),
    actions: {},
    pages: [],
  };
  seed.records = input.records.filter((r) => types.some((p) => p.type.key === r.type)).map((record) => ({ record, owner: seed.me }));
  seed.receipts = {};
  seed.approvals = [];
  const gateway = memoryGateway(seed);
  const defs = seed.definitions;
  const specs = new Map<string, ListSpec>();
  const specOf = (key: string): ListSpec | null => {
    const type = defs.recordTypes.find((x) => x.key === key);
    if (!type) return null;
    let s = specs.get(key);
    if (!s) {
      s = resolveListSpec(type, defs.workflows[key], defs.listViews?.[key], { workflows: defs.workflowSets?.[key] });
      specs.set(key, s);
    }
    return s;
  };
  const spec = specOf(input.subject.type.key)!;

  return {
    spec,
    gateway,
    specOf,
    async rows(chip, limit = spec.pageSize) {
      const c = spec.chips.find((x) => x.id === chip) ?? spec.chips.find((x) => x.id === spec.defaultChip);
      const res = await gateway.records.query(spec.type.key, {
        statusIn: c?.statusIn,
        owner: c?.owner,
        ...(c?.sharedWithMe ? { sharedWithMe: true as const } : {}),
        ...(c?.filters && Object.keys(c.filters).length ? { filters: c.filters } : {}),
        limit: Math.min(limit, 20),
      });
      return { rows: res.items.map((r) => plainRecordRow(spec, r)), total: res.total };
    },
    async panel(id, related) {
      const record = gateway.record(id);
      if (!record) return [];
      const extra = spec.related.length ? relatedDetail(await loadRelated(related ?? gateway.records, spec, id), specOf) : [];
      return [...detailSections(spec, record, [], VIEWER), ...extra];
    },
    create() {
      const steps = spec.createSteps.length ? spec.createSteps : [{ key: 'form', label: t('ui.records.new', { type: lowerLabel(spec.type.label) }), fields: spec.createKeys }];
      return steps.map((s) => ({ key: s.key, label: s.label, fields: fieldModels(spec.type, s.fields, {}, spec.workflow?.initial ?? null, VIEWER) }));
    },
  };
}
