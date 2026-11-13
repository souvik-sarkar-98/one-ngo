import type { GuideChapter, GuideSection, GuideStep, StageLine, StageRow, StageScreen } from './model';

/*
 * Turns the organisation's signed-in definition into guide chapters. The shapes
 * below are the slice of the runtime definition the guide reads. They are
 * structural, so the guide does not import the organisation app. Only labels,
 * keys and rules are read: no record data, and sensitive fields are left out.
 */

export interface GuideField {
  key: string;
  label: string;
  sensitive?: boolean;
  calculated?: string;
  rollup?: unknown;
}

export interface GuideRecordType {
  key: string;
  label: string;
  pluralLabel?: string;
  description?: string;
  titleField?: string;
  fields: GuideField[];
  numbering?: { format: string } | null;
  canCreate: boolean;
  canUpdate: boolean;
}

export interface GuideTransition {
  key: string;
  label: string;
  from: string[];
  requiredFields?: string[];
  allowed: boolean;
}

export interface GuideWorkflow {
  key: string;
  recordType: string;
  initial: string;
  states: { key: string; label: string }[];
  transitions: GuideTransition[];
}

export interface GuideDetailSection {
  id?: string;
  label: string;
  fields?: string[];
  related?: { recordType: string; field: string };
}

/** A list view. The record type keys the map that holds it; `key` is the name pages refer to it by. */
export interface GuideListView {
  key: string;
  label?: string;
  chips?: { id: string; label: string }[];
  defaultChip?: string;
  filters?: string[];
  columns?: string[];
  create?: { chips?: string[]; fields?: string[]; steps?: { key: string; label: string; fields: string[] }[] };
  edit?: { fields?: string[] };
  detail?: { sections: GuideDetailSection[] };
}

export interface GuideAction {
  key: string;
  label: string;
  /** A status test such as `status == 'paid'`. Absent, the action is offered in every state. */
  when?: string;
  placement: string[];
  confirm?: string;
  allowed: boolean;
}

export type GuideWidget =
  | { type: 'chart'; label: string; field?: string; measure: string; chart: string }
  | { type: 'list'; label: string; listView: string }
  | { type: 'stat'; label: string }
  | { type: 'links'; label: string; items: { label: string }[] }
  | { type: 'groups' };

export interface GuidePage {
  key: string;
  label: string;
  widgets: GuideWidget[];
}

export interface GuideDefinitions {
  theme?: { brand?: string } | null;
  recordTypes: GuideRecordType[];
  workflows: Record<string, GuideWorkflow>;
  listViews?: Record<string, GuideListView>;
  recordGroups?: { key: string; label: string; recordTypes: string[] }[];
  actions?: Record<string, GuideAction[]>;
  pages?: GuidePage[];
}

/** Every value in a generated chapter is a placeholder; no organisation data is drawn. */
const SAMPLE = 'Sample';
const FISCAL_YEAR = '2026-27';
const STATE_TEST = /status\s*==\s*'([a-z_]+)'/;

/** Fills a numbering format with a first-record sample: DON/{fy}/{seq:5} becomes DON/2026-27/00001. */
export function sampleNumber(format: string | null | undefined): string {
  if (!format) return '';
  return format
    .replace(/\{fy\}/g, FISCAL_YEAR)
    .replace(/\{seq(?::(\d+))?\}/g, (_match, width: string | undefined) => '1'.padStart(Number(width ?? 1), '0'))
    .replace(/\{[^}]*\}/g, 'X');
}

/** The state an action or step is shown in, read from its status test. Absent, the fallback applies. */
function stateIn(when: string | undefined): string | undefined {
  return when?.match(STATE_TEST)?.[1];
}

function labelOf(type: GuideRecordType, key: string): string {
  if (key === 'number') return 'Number';
  if (key === 'status') return 'Status';
  return type.fields.find((field) => field.key === key)?.label ?? key;
}

function pluralOf(defs: GuideDefinitions, key: string): string {
  const type = defs.recordTypes.find((item) => item.key === key);
  const view = defs.listViews?.[key];
  return view?.label || type?.pluralLabel || type?.label || key;
}

function stateLabel(workflow: GuideWorkflow | undefined, key: string): string {
  return workflow?.states.find((state) => state.key === key)?.label ?? key;
}

function blank(type: GuideRecordType, keys: string[], sensitive: Set<string>): StageLine[] {
  return keys.filter((key) => !sensitive.has(key)).map((key) => ({ label: labelOf(type, key), value: '' }));
}

/** Record types in group order, then any type no group names. */
function orderedTypes(defs: GuideDefinitions): { type: GuideRecordType; group: string }[] {
  const placed = new Set<string>();
  const out: { type: GuideRecordType; group: string }[] = [];
  for (const group of defs.recordGroups ?? []) {
    for (const key of group.recordTypes) {
      const type = defs.recordTypes.find((item) => item.key === key);
      if (type && !placed.has(key)) {
        placed.add(key);
        out.push({ type, group: group.label });
      }
    }
  }
  for (const type of defs.recordTypes) {
    if (!placed.has(type.key)) out.push({ type, group: 'Other' });
  }
  return out;
}

function overviewChapter(defs: GuideDefinitions): GuideChapter {
  const grouped = new Set((defs.recordGroups ?? []).flatMap((group) => group.recordTypes));
  const groups = (defs.recordGroups ?? []).map((group) => ({
    name: group.label,
    types: group.recordTypes.map((key) => pluralOf(defs, key)),
  }));
  const loose = defs.recordTypes.filter((type) => !grouped.has(type.key)).map((type) => pluralOf(defs, type.key));
  if (loose.length) groups.push({ name: 'Other', types: loose });
  const screen: StageScreen = { kind: 'home', greeting: 'Records', groups };
  const step: GuideStep = {
    title: 'Records',
    action: 'Tap Records. Groups stack in one column on every width.',
    path: '/records',
    mobile: 'Each record type is a row. There is no table.',
    web: 'The same single column. Wide screens do not place groups side by side.',
    highlight: 'nav:records',
    screen,
  };
  return { id: 'groups', title: 'Records', lead: 'The record groups in this organisation.', summary: 'Groups and record types', steps: [step] };
}

function typeChapter(defs: GuideDefinitions, type: GuideRecordType, group: string): GuideChapter {
  const view = defs.listViews?.[type.key];
  const plural = view?.label || type.pluralLabel || type.label;
  const workflow = defs.workflows[type.key];
  const sensitive = new Set(type.fields.filter((field) => field.sensitive).map((field) => field.key));
  const chips = view?.chips?.length ? view.chips : [{ id: 'all', label: 'All' }];
  const chip = chips.find((item) => item.id === view?.defaultChip) ?? chips[0]!;
  const initial = workflow?.initial ?? '';
  const number = sampleNumber(type.numbering?.format);
  const titleField = type.titleField ?? type.fields[0]?.key ?? 'name';
  const keys = view?.columns?.length
    ? view.columns
    : [...(type.numbering ? ['number'] : []), titleField, ...(workflow ? ['status'] : [])];
  const columns = keys.filter((key) => !sensitive.has(key));
  const row: StageRow = {
    title: SAMPLE,
    meta: number,
    ...(workflow ? { status: stateLabel(workflow, initial) } : {}),
    cells: columns.map((key) =>
      key === 'number' ? number : key === 'status' ? stateLabel(workflow, initial) : key === titleField ? SAMPLE : '',
    ),
  };
  const createOpen = type.canCreate && (!view?.create?.chips || view.create.chips.includes(chip.id));
  const ctx = ['Records', group, plural, number];
  const listOn = (extra: Partial<Extract<StageScreen, { kind: 'list' }>> = {}): StageScreen => ({
    kind: 'list',
    title: plural,
    crumbs: ['Records', group, plural],
    chips: chips.map((item) => item.label),
    chip: chip.label,
    search: `Search ${plural.toLowerCase()}`,
    pills: [],
    rows: [row],
    nav: 'records',
    back: true,
    fab: createOpen,
    columns: columns.map((key) => labelOf(type, key)),
    ...extra,
  });
  const panelOf = (
    heading: string,
    crumbs: string[],
    extra: { sections?: { label: string; lines: StageLine[] }[]; actions: string[]; primary?: string; confirm?: string },
  ): StageScreen => ({
    kind: 'panel',
    title: plural,
    crumbs,
    heading,
    lines: [],
    ...(extra.sections ? { sections: extra.sections } : {}),
    actions: extra.actions,
    ...(extra.primary ? { primary: extra.primary } : {}),
    ...(extra.confirm ? { confirm: extra.confirm } : {}),
    nav: 'records',
  });
  const step = (title: string, action: string, screen: StageScreen, highlight: string, query = ''): GuideStep => ({
    title,
    action,
    path: `/records/${type.key}${query}`,
    mobile: '',
    web: '',
    highlight,
    screen,
  });

  /** The record's sections with its status shown in the given state. */
  const sectionsIn = (state: string): { label: string; lines: StageLine[] }[] => {
    const detail = view?.detail?.sections ?? [];
    const groups = detail.length
      ? detail.map((section) => ({
          label: section.label,
          lines: section.related
            ? [{ label: pluralOf(defs, section.related.recordType), value: '' }]
            : blank(type, section.fields ?? [], sensitive),
        }))
      : [{ label: type.label, lines: blank(type, type.fields.map((field) => field.key), sensitive) }];
    if (!workflow || !groups.length) return groups;
    const [first, ...rest] = groups;
    return [{ label: first!.label, lines: [{ label: 'Status', value: stateLabel(workflow, state) }, ...first!.lines] }, ...rest];
  };
  /** Transitions and panel actions offered in a state. */
  const transitionsFrom = (state: string) => (workflow?.transitions ?? []).filter((item) => item.allowed && item.from.includes(state));
  const actionsIn = (state: string) =>
    (defs.actions?.[type.key] ?? []).filter((item) => item.allowed && item.placement.includes('panel') && (stateIn(item.when) ?? state) === state);
  const recordPanel = (state: string, primary?: string, confirm?: string) => {
    const actions = [...transitionsFrom(state).map((item) => item.label), ...actionsIn(state).map((item) => item.label)];
    return panelOf(SAMPLE, ctx, { sections: sectionsIn(state), actions, primary: primary ?? actions[0], confirm });
  };
  const steps: GuideStep[] = [];

  steps.push(step(`${plural} on ${chip.label}`, `Open ${plural}. The list opens on ${chip.label}.`, listOn(), `chip:${chip.label}`, `?chip=${chip.id}`));

  if (view?.filters?.length) {
    steps.push(
      step(
        'Search and filters',
        'Search, then open Filters. Filters apply to the list and stay in the address.',
        listOn({ pills: view.filters.map((key) => labelOf(type, key)) }),
        'search',
      ),
    );
  }

  steps.push(step('Open the record', 'Tap the first row. The record opens in the panel.', recordPanel(initial), 'row'));

  for (const transition of transitionsFrom(initial)) {
    steps.push(
      step(
        transition.label,
        `Tap ${transition.label}. The step asks only for the fields it needs.`,
        panelOf(transition.label, [...ctx, transition.label], {
          sections: transition.requiredFields?.length ? [{ label: 'Required', lines: blank(type, transition.requiredFields, sensitive) }] : [],
          actions: ['Back', transition.label],
          primary: transition.label,
        }),
        `action:${transition.label}`,
      ),
    );
  }

  if (createOpen) {
    steps.push(step(`New ${type.label.toLowerCase()}`, 'Tap + on the list to start a record.', listOn(), 'fab'));
    const createSteps = view?.create?.steps ?? [];
    if (createSteps.length) {
      createSteps.forEach((part, index) => {
        const last = index === createSteps.length - 1;
        const label = last ? 'Create' : 'Next';
        steps.push(
          step(
            `New ${type.label.toLowerCase()} · ${part.label}`,
            `Fill in ${part.label}. ${last ? 'Create saves the record.' : 'Next moves to the next part.'}`,
            panelOf(`${part.label} · Step ${index + 1} of ${createSteps.length}`, [...ctx.slice(0, 3), 'New'], {
              sections: [{ label: part.label, lines: blank(type, part.fields, sensitive) }],
              actions: index === 0 ? ['Cancel', label] : ['Back', label],
              primary: label,
            }),
            `action:${label}`,
          ),
        );
      });
    } else {
      const fields = view?.create?.fields?.length
        ? view.create.fields
        : type.fields.filter((field) => !field.calculated && !field.rollup).map((field) => field.key);
      steps.push(
        step(
          `New ${type.label.toLowerCase()} form`,
          'Fill in the fields, then Create.',
          panelOf(`New ${type.label}`, [...ctx.slice(0, 3), 'New'], {
            sections: [{ label: type.label, lines: blank(type, fields, sensitive) }],
            actions: ['Cancel', 'Create'],
            primary: 'Create',
          }),
          'action:Create',
        ),
      );
    }
  }

  if (type.canUpdate && view?.edit?.fields?.length) {
    steps.push(
      step(
        'Edit',
        'Open the record, tap Edit, change a field, then Save.',
        panelOf(SAMPLE, [...ctx, 'Edit'], {
          sections: [{ label: type.label, lines: blank(type, view.edit.fields, sensitive) }],
          actions: ['Cancel', 'Save'],
          primary: 'Save',
        }),
        'action:Save',
      ),
    );
  }

  for (const action of (defs.actions?.[type.key] ?? []).filter((item) => item.allowed)) {
    const state = stateIn(action.when) ?? initial;
    if (action.placement.includes('panel')) {
      steps.push(step(action.label, `Open the record and tap ${action.label}.`, recordPanel(state, action.label, action.confirm), `action:${action.label}`));
    }
    if (action.placement.includes('bulk')) {
      steps.push(
        step(
          `${action.label} on several`,
          `Select records, then tap ${action.label}.`,
          listOn({ bulk: [action.label], pills: ['2 selected'] }),
          `action:${action.label}`,
        ),
      );
    }
  }

  return { id: type.key, title: plural, lead: type.description ?? chip.label, summary: type.description ?? chip.label, steps };
}

/** A widget's line on a page: its name and what it draws, without any values. */
function widgetLine(widget: GuideWidget, defs: GuideDefinitions): { name: string; types: string[] } {
  if (widget.type === 'groups') return { name: 'Record groups', types: ['Each group and its types'] };
  if (widget.type === 'chart') {
    return { name: widget.label, types: [`${widget.chart === 'line' ? 'Line' : 'Bar'} chart of ${widget.field ?? 'records'}`] };
  }
  if (widget.type === 'list') {
    const view = Object.values(defs.listViews ?? {}).find((item) => item.key === widget.listView);
    return { name: widget.label, types: [`Short list from ${view?.label ?? widget.listView}`] };
  }
  if (widget.type === 'links') return { name: widget.label, types: widget.items.map((item) => item.label) };
  return { name: widget.label, types: ['Count or total'] };
}

function pagesChapter(defs: GuideDefinitions): GuideChapter {
  const pages = defs.pages ?? [];
  const steps: GuideStep[] = pages.map((page) => ({
    title: page.label,
    action: `More, then ${page.label}.`,
    path: `/pages/${page.key}`,
    mobile: '',
    web: '',
    highlight: 'heading',
    screen: { kind: 'home', greeting: page.label, groups: page.widgets.map((widget) => widgetLine(widget, defs)) },
  }));
  return { id: 'pages', title: 'Pages', lead: 'Extra pages from More, built from widgets.', summary: pages.map((page) => page.label).join(' · '), steps };
}

/** The records section, or null when the definition has no record types. */
export function projectDefinitions(defs: GuideDefinitions): GuideSection | null {
  if (!defs.recordTypes?.length) return null;
  const chapters = [
    overviewChapter(defs),
    ...orderedTypes(defs).map(({ type, group }) => typeChapter(defs, type, group)),
    ...(defs.pages?.length ? [pagesChapter(defs)] : []),
  ];
  return { id: 'records', label: 'Your records', icon: 'records', source: 'The organisation definition', chapters };
}
