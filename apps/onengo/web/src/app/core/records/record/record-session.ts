import { t } from '../../i18n/i18n';
import { focusFirstInvalid } from './focus-invalid';
import type { FormLayout, PendingApproval, Receipt, RecordView, RuntimeAction } from '../../models';
import {
  actionForm,
  availableActions,
  createRecord,
  decide,
  recordActions,
  recordExtras,
  runAction,
  runStep,
  saveEdit,
  showsConfirmation,
  type ActionResult,
  type AvailableActions,
  type RecordActions,
  type StepAction,
} from './actions';
import { asSignature, dataUrlBlob, type FileUploader } from '../../fields/files';
import { peopleSource, type PeopleGateway } from '../../people/people';
import type { Suggestion, SuggestionSource } from '../../ui-logic/autocomplete';
import { changedOnly, fieldModels, formProblems, fromFormValues, splitIssues, stepKeys, toFormValues, type FieldModel, type FieldOptions, type FormValues, type Viewer } from './forms';
import { asGatewayError, type RecordsGateway } from '../gateway/gateway';
import { recordTitle, type DetailSection } from './present';
import { copyPicked, personTitles, pickReference, recordSource, referenceTitles, type PickOption } from './references';
import { loadRelated, relatedCreates, relatedDetail, type RelatedCreate, type RelatedSection } from './related';
import type { ListSpec } from '../spec';
import type { ListState } from '../list/url';

/** What a record session may know of the rest of the app: the other record types it points at, and who can be chosen in person fields. */
export interface RecordLinks {
  /** The list spec of another record type the person can read, or null. */
  spec(type: string): ListSpec | null;
  people?: PeopleGateway;
}

const NO_LINKS: RecordLinks = { spec: () => null };

/** What the open record is being used for. */
export type RecordMode =
  | { kind: 'view' }
  | { kind: 'edit' }
  | { kind: 'step'; step: string }
  | { kind: 'action'; action: string }
  | { kind: 'share' }
  | { kind: 'create'; step: number };

export interface RecordSnapshot {
  record: RecordView | null;
  receipts: Receipt[];
  pending: PendingApproval | null;
  /** The list view's related sections for the open record. */
  related: RelatedSection[];
  mode: RecordMode | null;
  values: FormValues;
  /** What chosen references and people are shown as, by id. */
  titles: Record<string, string>;
  /** An action is showing its confirmation in place of its form. Not kept in the address, so a reload returns to the form. */
  confirming: boolean;
  loading: boolean;
  busy: boolean;
  /** Per-field problems from the last save attempt. */
  errors: Record<string, string>;
  /** Problems that belong to no one field. */
  general: string[];
  error: string;
  message: string;
}

export interface RecordHooks {
  /** A record was saved or created; the list puts it in place. `open` is where an action asked the app to go next. */
  saved(record: RecordView, created: boolean, open?: string): void;
  /** Opening the record failed; the screen closes it. */
  failed(message: string): void;
}

const IDLE: RecordSnapshot = {
  record: null,
  receipts: [],
  pending: null,
  related: [],
  mode: null,
  values: {},
  titles: {},
  confirming: false,
  loading: false,
  busy: false,
  errors: {},
  general: [],
  error: '',
  message: '',
};

/**
 * One record on screen, however it is drawn: the cards detail sheet, its
 * step and create sheets, and the table's record page all use this. It follows
 * the list state from the address bar, loads the record with its receipts and
 * pending approval, holds the form values for the current mode, and runs
 * saves, workflow steps, create, and approval decisions.
 */
export class RecordSession {
  private snap: RecordSnapshot = IDLE;
  private readonly listeners = new Set<(s: RecordSnapshot) => void>();
  private modeKey = '';
  private loadingId: string | null = null;
  private readonly sources = new Map<string, SuggestionSource>();
  private readonly loadingTitles = new Set<string>();

  constructor(
    private readonly gateway: RecordsGateway,
    private readonly spec: ListSpec,
    private readonly viewer: () => Viewer,
    private readonly hooks: RecordHooks,
    private readonly links: RecordLinks = NO_LINKS,
    private readonly files?: FileUploader,
  ) {}

  get snapshot(): RecordSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: RecordSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** Brings the session in line with the address bar. `known` is the list's copy of the row, shown while a fresh one loads. */
  follow(state: ListState, known?: RecordView): Promise<void> {
    if (state.create) {
      this.setMode({ kind: 'create', step: state.createStep }, state.presets);
      return Promise.resolve();
    }
    if (!state.id) {
      this.loadingId = null;
      this.modeKey = '';
      this.set(IDLE);
      return Promise.resolve();
    }
    const mode: RecordMode = state.panel;
    if (this.snap.record?.id === state.id || this.loadingId === state.id) {
      this.setMode(mode);
      return Promise.resolve();
    }
    return this.open(state.id, mode, known);
  }

  /**
   * New values from the form. A field's message goes as soon as that field
   * changes, so "Payment method is required for this step" cannot outlive the
   * empty field it complained about. The form is checked again on save.
   */
  setValues(values: FormValues): void {
    const same = (key: string) => JSON.stringify(values[key] ?? null) === JSON.stringify(this.snap.values[key] ?? null);
    const errors = Object.fromEntries(Object.entries(this.snap.errors).filter(([key]) => same(key)));
    this.set({ values, ...(Object.keys(errors).length === Object.keys(this.snap.errors).length ? {} : { errors }) });
  }

  /**
   * Chooses a record in a reference field and mirrors its `copyFrom` values
   * into the form, so fields locked by `editableWhen` lock (or unlock, when
   * cleared) at once. The server copies again on save.
   */
  pickReference(key: string, picked: RecordView | null): void {
    this.set({ values: pickReference(this.spec.type, this.snap.values, key, picked) });
  }

  /**
   * Takes a picker suggestion for field `key`, or clears it with null. A
   * person is kept by id and shown by name; "New <type> “text”" creates the
   * record from the typed text first and chooses it.
   */
  async choose(key: string, option: Suggestion | null): Promise<void> {
    const o = option as PickOption | null;
    const field = this.fieldDefs().find((f) => f.key === key);
    if (!o || !field) return this.pickReference(key, null);
    const { [key]: _, ...errors } = this.snap.errors;
    if (field.type === 'person') {
      this.set({ values: { ...this.snap.values, [key]: o.id }, titles: { ...this.snap.titles, [o.id]: o.label }, errors });
      return;
    }
    const spec = field.referenceType ? this.links.spec(field.referenceType) : null;
    let picked = o.record ?? null;
    if (o.create !== undefined && spec?.type.titleField) {
      this.set({ busy: true, errors });
      try {
        picked = (await this.gateway.create(spec.type.key, { [spec.type.titleField]: o.create })).record;
      } catch (e) {
        this.set({ errors: { ...this.snap.errors, [key]: asGatewayError(e, t('ui.common.somethingWentWrong')).message } });
        return;
      } finally {
        this.set({ busy: false });
      }
    }
    if (!picked) return;
    this.set({ titles: { ...this.snap.titles, [picked.id]: spec ? recordTitle(spec, picked) : o.label }, errors });
    this.pickReference(key, picked);
  }

  // --------------------------------------------------------------- derived

  /** Where a reference or person field finds its choices and what it shows now; null for other fields, or a type the person cannot read. */
  picker(field: FieldModel): { source: SuggestionSource; text: string } | null {
    const source = this.sourceFor(field);
    if (!source) return null;
    const v = this.snap.values[field.key];
    return { source, text: typeof v === 'string' && v ? (this.snap.titles[v] ?? '') : '' };
  }

  /** The open record's related sections as detail sections. */
  relatedSections(): DetailSection[] {
    return relatedDetail(this.snap.related, (type) => this.links.spec(type));
  }

  /** "New … for this record" for each related type the person may create with this record chosen. */
  relatedCreates(): RelatedCreate[] {
    const r = this.snap.record;
    return r ? relatedCreates(this.spec, r, (type) => this.links.spec(type)) : [];
  }

  actions(chip?: string): AvailableActions | null {
    return this.snap.record ? availableActions(this.spec, this.snap.record, chip) : null;
  }

  /** Edit, the allowed steps of every workflow the record is in, and the configured actions on offer. */
  recordActions(chip?: string): RecordActions | null {
    return this.snap.record ? recordActions(this.spec, this.snap.record, this.viewer(), chip) : null;
  }

  /** The step the session is running, when it is in step mode and the step is allowed. */
  currentStep(chip?: string): StepAction | null {
    const mode = this.snap.mode;
    if (mode?.kind !== 'step') return null;
    return this.recordActions(chip)?.workflows.flatMap((w) => w.steps).find((s) => s.key === mode.step) ?? null;
  }

  /** The action the session is running, when it is in action mode and the action is on offer for the record. */
  currentAction(chip?: string): RuntimeAction | null {
    const mode = this.snap.mode;
    if (mode?.kind !== 'action') return null;
    return this.recordActions(chip)?.actions.find((a) => a.key === mode.action) ?? null;
  }

  /** How the open form is laid out on wide screens: the create form's, an action's own, or the edit form's. A workflow step is one column. */
  formLayout(): FormLayout {
    const mode = this.snap.mode;
    if (mode?.kind === 'create') return this.spec.createLayout;
    if (mode?.kind === 'action') {
      const form = this.actionDef(mode.action)?.form;
      return { columns: form?.columns ?? 1, fullWidth: form?.fullWidth ?? [] };
    }
    if (mode?.kind === 'step') return { columns: 1, fullWidth: [] };
    return this.spec.editLayout;
  }

  /** The keys a form shows by default for the current mode. */
  defaultKeys(): string[] {
    const mode = this.snap.mode;
    if (mode?.kind === 'create') return this.spec.createSteps[mode.step]?.fields ?? this.spec.createKeys;
    if (mode?.kind === 'action') return actionForm(this.actionDef(mode.action)).fields.map((f) => f.key);
    if (mode?.kind === 'step') {
      const step = this.spec.workflows.flatMap((w) => w.transitions).find((t) => t.key === mode.step);
      const r = this.snap.record;
      return step ? stepKeys(this.spec.type, step, r?.data ?? {}, r?.status ?? null, this.viewer()) : [];
    }
    return this.spec.editKeys;
  }

  /**
   * The fields to show for the given keys, judged against the record as it
   * would be after this form: hidden fields are left out and fields that may
   * not change are read-only.
   */
  fields(keys: string[] = this.defaultKeys(), opts: FieldOptions = {}): FieldModel[] {
    const { record, mode } = this.snap;
    if (mode?.kind === 'action') {
      const form = actionForm(this.actionDef(mode.action));
      return fieldModels(form, keys, fromFormValues(form, this.snap.values), record?.status ?? null, this.viewer(), opts);
    }
    const data = { ...(record?.data ?? {}), ...fromFormValues(this.spec.type, this.snap.values) };
    const status =
      mode?.kind === 'create'
        ? (this.spec.workflow?.initial ?? null)
        : mode?.kind === 'step'
          ? (this.spec.workflow?.transitions.find((t) => t.key === mode.step)?.to ?? record?.status ?? null)
          : (record?.status ?? null);
    return fieldModels(this.spec.type, keys, data, status, this.viewer(), opts);
  }

  /** Whether any editable value among `fields` differs from the stored record. */
  isDirty(fields: FieldModel[]): boolean {
    const r = this.snap.record;
    return !!r && Object.keys(changedOnly(r.data, fromFormValues(this.spec.type, this.snap.values, editable(fields)))).length > 0;
  }

  // --------------------------------------------------------------- actions

  /** Saves the editable values among `fields`. */
  save(fields: FieldModel[]): Promise<void> {
    const r = this.snap.record!;
    return this.run(fields, () => saveEdit(this.gateway, this.spec, r, this.snap.values, editable(fields)));
  }

  /** Runs a workflow step, sending the editable values among `fields` with it. */
  step(step: StepAction, fields: FieldModel[]): Promise<void> {
    const r = this.snap.record!;
    return this.run(fields, () => runStep(this.gateway, this.spec, r, step, this.snap.values, editable(fields)));
  }

  /**
   * Runs a configured action on the open record with the values among
   * `fields`. An action with a form and a confirmation first checks the form
   * and shows the confirmation; running it again from there sends it.
   */
  async act(action: RuntimeAction, fields: FieldModel[]): Promise<void> {
    if (!showsConfirmation(action, this.snap.confirming) && action.confirm) {
      if (this.check(fields)) this.set({ confirming: true, error: '', general: [] });
      return;
    }
    const r = this.snap.record!;
    await this.run(fields, () => runAction(this.gateway, this.spec, r, action, this.snap.values));
    this.set({ confirming: false });
  }

  /** From the confirmation back to the action's form, keeping what was filled in. */
  backToForm(): void {
    this.set({ confirming: false });
  }

  /** Runs an action that needs no form or confirmation on a listed record, whether or not it is the open one. */
  async runOn(record: RecordView, action: RuntimeAction): Promise<void> {
    if (this.snap.record?.id === record.id) return this.act(action, []);
    this.set({ busy: true, error: '', message: '' });
    try {
      const res = await runAction(this.gateway, this.spec, record, action, {});
      this.set({ message: res.message });
      this.hooks.saved(res.record, false, res.open);
    } catch (e) {
      this.set({ error: asGatewayError(e, t('ui.common.somethingWentWrong')).message });
    } finally {
      this.set({ busy: false });
    }
  }

  /** Creates a record from the create fields; on a stepper, checks only the current step. */
  create(fields: FieldModel[]): Promise<void> {
    return this.run(fields, () => createRecord(this.gateway, this.spec, this.snap.values, this.spec.createKeys));
  }

  /** Checks the given fields before moving to the next create step. Returns whether it may move on. */
  check(fields: FieldModel[]): boolean {
    const errors = formProblems(fields, this.snap.values);
    this.set({ errors });
    const ok = !Object.keys(errors).length;
    if (!ok) focusFirstInvalid();
    return ok;
  }

  async decide(decision: 'approve' | 'reject'): Promise<void> {
    const p = this.snap.pending;
    const r = this.snap.record;
    if (!p || !r) return;
    await this.run([], async () => {
      const message = await decide(this.gateway, p, decision);
      const record = await this.gateway.get(this.spec.type.key, r.id);
      return { record, receipts: [], message };
    });
  }

  // --------------------------------------------------------------- inside

  private async open(id: string, mode: RecordMode, known?: RecordView): Promise<void> {
    this.loadingId = id;
    this.modeKey = '';
    this.set({ ...IDLE, record: known ?? null, loading: true });
    this.setMode(mode);
    try {
      const record = await this.gateway.get(this.spec.type.key, id);
      if (this.loadingId !== id) return;
      this.set({ record });
      if (!this.snap.busy) this.resetValues();
      const [extras, related] = await Promise.all([recordExtras(this.gateway, this.spec, id), loadRelated(this.gateway, this.spec, id)]);
      if (this.loadingId !== id) return;
      this.set({ ...extras, related, loading: false });
    } catch (e) {
      if (this.loadingId !== id) return;
      this.loadingId = null;
      const message = asGatewayError(e, t('ui.records.loadRecordFailed')).message;
      this.set({ loading: false, error: message });
      this.hooks.failed(message);
    }
  }

  private setMode(mode: RecordMode, presets: Record<string, string> = {}): void {
    const key = JSON.stringify([this.snap.record?.id ?? null, mode.kind === 'create' ? presets : mode]);
    const sameCreate = mode.kind === 'create' && this.snap.mode?.kind === 'create';
    this.set({ mode });
    if (key === this.modeKey) return;
    this.modeKey = key;
    // What just happened to this record outlives the form it happened in: an action
    // closes its confirmation as it finishes, and its message has to survive that.
    this.set({ errors: {}, general: [], error: '', confirming: false });
    if (!sameCreate) this.resetValues(presets);
  }

  private actionDef(key: string): RuntimeAction | undefined {
    return this.spec.actions.find((a) => a.key === key);
  }

  /** The definitions of the fields the current form can hold. */
  private fieldDefs() {
    const mode = this.snap.mode;
    return mode?.kind === 'action' ? actionForm(this.actionDef(mode.action)).fields : this.spec.type.fields;
  }

  private sourceFor(field: FieldModel): SuggestionSource | null {
    const key = field.kind === 'person' ? 'person' : field.kind === 'reference' && field.referenceType ? `record:${field.referenceType}` : '';
    if (!key) return null;
    let source = this.sources.get(key);
    if (!source) {
      const spec = field.kind === 'reference' ? this.links.spec(field.referenceType!) : null;
      if (field.kind === 'person' ? !this.links.people : !spec) return null;
      source = spec ? recordSource(this.gateway, spec) : peopleSource(this.links.people!);
      this.sources.set(key, source);
    }
    return source;
  }

  /**
   * Fills in the titles of the chosen references and people in the form,
   * loading the ones not seen yet. On create, a reference that arrived as a
   * preset ("New donation for Ravi") also fills its copied fields.
   */
  private refreshTitles(): void {
    const fields = this.fieldDefs();
    const people = personTitles(fields, this.snap.record?.data ?? {});
    if (Object.keys(people).some((id) => !(id in this.snap.titles))) this.set({ titles: { ...people, ...this.snap.titles } });
    const claim = (id: string) => {
      if (id in this.snap.titles || this.loadingTitles.has(id)) return true;
      this.loadingTitles.add(id);
      return false;
    };
    const modeKey = this.modeKey;
    void referenceTitles(this.gateway, fields, this.snap.values, claim, (type) => this.links.spec(type)).then(({ titles, records }) => {
      Object.keys(titles).forEach((id) => this.loadingTitles.delete(id));
      if (!Object.keys(titles).length) return;
      let values = this.snap.values;
      if (this.snap.mode?.kind === 'create' && this.modeKey === modeKey) {
        for (const r of records) for (const f of fields) if (f.type === 'reference' && values[f.key] === r.id) values = copyPicked(this.spec.type, values, f.key, r);
      }
      this.set({ titles: { ...this.snap.titles, ...titles }, values });
    });
  }

  private resetValues(presets: Record<string, string> = {}): void {
    const { record, mode } = this.snap;
    if (mode?.kind === 'action') this.set({ values: toFormValues(actionForm(this.actionDef(mode.action)), {}) });
    else if (mode?.kind === 'create') {
      const values = toFormValues(this.spec.type, {});
      for (const p of this.spec.presets) if (presets[p.param] !== undefined) values[p.field] = presets[p.param]!;
      this.set({ record: null, receipts: [], pending: null, related: [], values });
    } else this.set({ values: record ? toFormValues(this.spec.type, record.data) : {} });
    this.refreshTitles();
  }

  private async run(fields: FieldModel[], action: () => Promise<ActionResult>): Promise<void> {
    if (!this.check(fields)) return;
    this.set({ busy: true, error: '', message: '', general: [] });
    const created = this.snap.mode?.kind === 'create';
    try {
      await this.uploadSignatures(fields);
      const res = await action();
      const extras = await recordExtras(this.gateway, this.spec, res.record.id);
      const mode: RecordMode = created ? { kind: 'view' } : this.snap.mode!;
      this.loadingId = res.record.id;
      this.set({ record: res.record, ...extras, receipts: res.receipts.length ? res.receipts : extras.receipts, message: res.message, mode });
      this.modeKey = JSON.stringify([res.record.id, mode]);
      this.resetValues();
      this.hooks.saved(res.record, created, res.open);
    } catch (e) {
      const err = asGatewayError(e, t('ui.common.somethingWentWrong'));
      const split = splitIssues(err.message, err.issues ?? [], Object.fromEntries(fields.map((f) => [f.key, f.label])));
      this.set({ error: err.message, errors: split.fields, general: split.general });
      if (Object.keys(split.fields).length) focusFirstInvalid();
      if (err.code === 'conflict' && this.snap.record) {
        const record = await this.gateway.get(this.spec.type.key, this.snap.record.id).catch(() => null);
        if (record) this.set({ record });
      }
    } finally {
      this.set({ busy: false });
    }
  }

  /** New drawings on signature pads upload as PNG files on save; the saved value then names the file. */
  private async uploadSignatures(fields: FieldModel[]): Promise<void> {
    let values = this.snap.values;
    for (const f of fields) {
      const s = f.kind === 'signature' && !f.readOnly ? asSignature(values[f.key]) : null;
      if (!s?.drawing || s.file || !this.files) continue;
      const file = await this.files.upload(dataUrlBlob(s.drawing), `${f.key}.png`, f.upload);
      values = { ...values, [f.key]: { ...s, file: file.id } };
    }
    if (values !== this.snap.values) this.set({ values });
  }

  private set(change: Partial<RecordSnapshot>): void {
    this.snap = { ...this.snap, ...change };
    for (const fn of this.listeners) fn(this.snap);
  }
}

function editable(fields: FieldModel[]): string[] {
  return fields.filter((f) => !f.readOnly).map((f) => f.key);
}
