import type { Suggestion, SuggestionSource } from '../ui-logic/autocomplete';
import type { RecordView } from '../models';
import type { Timers } from './draft-session';
import type { ExpressionAssist } from './expression-assist';
import {
  applySuggestion,
  expressionCatalogue,
  insertEntry,
  NO_SUBJECT,
  recordLabel,
  replaceWordAt,
  sampleFromRecord,
  sampleScope,
  sampleSlots,
  suggest,
  type CatalogueEntry,
  type Edit,
  type ExpressionCheck,
  type ExpressionContext,
  type ExpressionSubject,
  type SampleSlot,
  type Suggestions,
} from './expression-catalogue';
import type { ExpressionTry } from './http-builder';

export interface ExpressionSettings {
  recordType: string | null;
  context: ExpressionContext;
  /** The action form's field keys; left out when there is no form to check against. */
  input?: readonly string[];
}

/** `empty`: nothing to check; `failed`: the check itself could not run. */
export type CheckState = 'empty' | 'checking' | 'ok' | 'error' | 'failed';

export interface ExpressionState {
  source: string;
  cursor: number;
  /** Goes up when the session itself moves the cursor, e.g. after a suggestion is chosen. */
  jump: number;
  subject: ExpressionSubject;
  catalogue: CatalogueEntry[];
  suggestions: Suggestions | null;
  active: number;
  checkState: CheckState;
  check: ExpressionCheck | null;
  slots: SampleSlot[];
  sample: Record<string, string>;
  /** The real record "Try it" runs on; null runs on the sample values. */
  record: { id: string; label: string } | null;
  trying: boolean;
  tried: ExpressionTry | null;
  tryFailed: boolean;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const sameSettings = (a: ExpressionSettings, b: ExpressionSettings) =>
  a.recordType === b.recordType && a.context === b.context && (a.input ?? null)?.join() === (b.input ?? null)?.join();

/**
 * One expression being written: suggestions at the cursor, the server's
 * check `delay` ms after typing stops (older answers dropped), and "Try it"
 * on a real record or on sample values.
 */
export class ExpressionSession {
  private snap: ExpressionState;
  private readonly listeners = new Set<(s: ExpressionState) => void>();
  private settings: ExpressionSettings;
  private timer: unknown;
  private checks = 0;
  private loads = 0;
  private loading = false;
  private readonly found = new Map<string, RecordView>();

  constructor(
    private readonly assist: ExpressionAssist,
    settings: ExpressionSettings,
    source = '',
    private readonly delay = 400,
    private readonly timers: Timers = realTimers,
  ) {
    this.settings = settings;
    this.snap = {
      source,
      cursor: source.length,
      jump: 0,
      subject: NO_SUBJECT,
      catalogue: [],
      suggestions: null,
      active: -1,
      checkState: source.trim() ? 'checking' : 'empty',
      check: null,
      slots: [],
      sample: {},
      record: null,
      trying: false,
      tried: null,
      tryFailed: false,
    };
    this.configure(settings, true);
  }

  get snapshot(): ExpressionState {
    return this.snap;
  }

  subscribe(fn: (s: ExpressionState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** The record type, context or form changed: suggestions and the check follow. */
  configure(settings: ExpressionSettings, force = false): void {
    if (!force && sameSettings(settings, this.settings)) return;
    this.settings = settings;
    const load = ++this.loads;
    this.loading = true;
    this.set({ catalogue: expressionCatalogue(NO_SUBJECT, settings.context, settings.input), record: null });
    void this.assist
      .subject(settings.recordType)
      .catch(() => NO_SUBJECT)
      .then((subject) => {
        if (load !== this.loads) return;
        this.loading = false;
        this.set({ subject, catalogue: expressionCatalogue(subject, settings.context, settings.input), slots: sampleSlots(this.snap.source, subject) ?? this.snap.slots });
        this.schedule(0);
      });
  }

  /** The value changed from outside, e.g. the draft was restored. */
  setSource(source: string): void {
    if (source === this.snap.source) return;
    this.edited({ source, cursor: source.length }, false);
  }

  /** Typing: suggests for the word at the cursor. */
  input(source: string, cursor: number): void {
    const suggestions = suggest(source, cursor, this.snap.catalogue);
    this.set({ source, cursor, suggestions, active: suggestions ? 0 : -1 });
    this.afterEdit();
  }

  /** The cursor moved without typing, e.g. a click. */
  caret(cursor: number): void {
    this.set({ cursor, suggestions: null, active: -1 });
  }

  /** Handles a key in the box; returns whether it was used. Ctrl+Space suggests for the word at the cursor. */
  key(key: string, ctrl = false): boolean {
    const { suggestions, active } = this.snap;
    if (key === ' ' && ctrl) {
      const s = suggest(this.snap.source, this.snap.cursor, this.snap.catalogue, { explicit: true });
      this.set({ suggestions: s, active: s ? 0 : -1 });
      return true;
    }
    if (!suggestions) return false;
    const last = suggestions.items.length - 1;
    switch (key) {
      case 'ArrowDown':
        this.set({ active: active >= last ? 0 : active + 1 });
        return true;
      case 'ArrowUp':
        this.set({ active: active <= 0 ? last : active - 1 });
        return true;
      case 'Enter':
      case 'Tab':
        return active >= 0 && this.choose(active);
      case 'Escape':
        this.close();
        return true;
      default:
        return false;
    }
  }

  highlight(index: number): void {
    if (this.snap.suggestions && index >= 0 && index < this.snap.suggestions.items.length) this.set({ active: index });
  }

  choose(index: number): boolean {
    const s = this.snap.suggestions;
    const entry = s?.items[index];
    if (!s || !entry) return false;
    this.edited(applySuggestion(this.snap.source, s, entry), true);
    return true;
  }

  close(): void {
    if (this.snap.suggestions) this.set({ suggestions: null, active: -1 });
  }

  /** Writes a field or function at the cursor, as its button does. */
  insert(entry: CatalogueEntry): void {
    this.edited(insertEntry(this.snap.source, this.snap.cursor, entry), true);
  }

  /** Takes the check's "did you mean". */
  fix(): void {
    const c = this.snap.check;
    if (!c?.suggestion || c.position === undefined) return;
    const edit = replaceWordAt(this.snap.source, c.position, c.suggestion);
    if (edit) this.edited(edit, true);
  }

  /** Real records of the record type for the "Try it" picker. */
  readonly recordSource: SuggestionSource = {
    minLength: 0,
    search: async (text): Promise<Suggestion[]> => {
      const type = this.snap.subject.recordType;
      if (!type) return [];
      const found = await this.assist.records(type.key, text);
      for (const r of found) this.found.set(r.id, r);
      return found.map((r) => ({ id: r.id, label: recordLabel(type, r), ...(r.status ? { hint: r.status } : {}) }));
    },
  };

  /** Tries on a real record; its values are shown, and editing one tries on the edited values instead. */
  pickRecord(id: string): void {
    const r = this.found.get(id);
    if (!r) return;
    this.set({
      record: { id, label: recordLabel(this.snap.subject.recordType, r) },
      sample: { ...this.snap.sample, ...sampleFromRecord(this.snap.slots, r) },
      tried: null,
      tryFailed: false,
    });
  }

  setSample(path: string, value: string): void {
    this.set({ sample: { ...this.snap.sample, [path]: value }, record: null, tried: null });
  }

  async tryIt(): Promise<void> {
    const { source, record, slots, sample, subject } = this.snap;
    if (!source.trim()) return;
    this.set({ trying: true, tryFailed: false });
    try {
      const tried = await this.assist.try({
        source,
        ...(subject.recordType ? { recordType: subject.recordType.key } : {}),
        ...(record ? { recordId: record.id } : { sample: sampleScope(slots, sample) }),
      });
      if (source === this.snap.source) this.set({ trying: false, tried });
      else this.set({ trying: false });
    } catch {
      this.set({ trying: false, tried: null, tryFailed: true });
    }
  }

  dispose(): void {
    this.timers.clear(this.timer);
    this.checks++;
    this.loads++;
    this.listeners.clear();
  }

  private edited(edit: Edit, jump: boolean): void {
    this.set({ source: edit.source, cursor: edit.cursor, suggestions: null, active: -1, ...(jump ? { jump: this.snap.jump + 1 } : {}) });
    this.afterEdit();
  }

  private afterEdit(): void {
    const slots = sampleSlots(this.snap.source, this.snap.subject);
    this.set({ tried: null, tryFailed: false, ...(slots ? { slots } : {}) });
    this.schedule(this.delay);
  }

  private schedule(ms: number): void {
    this.timers.clear(this.timer);
    const generation = ++this.checks;
    const source = this.snap.source;
    if (!source.trim()) {
      this.set({ checkState: 'empty', check: null });
      return;
    }
    this.set({ checkState: 'checking' });
    if (this.loading) return;
    const run = () => void this.check(source, generation);
    if (ms <= 0) run();
    else this.timer = this.timers.set(run, ms);
  }

  private async check(source: string, generation: number): Promise<void> {
    const { recordType } = this.snap.subject;
    const { context, input } = this.settings;
    try {
      const check = await this.assist.check({ source, ...(recordType ? { recordType: recordType.key } : {}), context, ...(input ? { input: [...input] } : {}) });
      if (generation === this.checks) this.set({ checkState: check.ok ? 'ok' : 'error', check });
    } catch {
      if (generation === this.checks) this.set({ checkState: 'failed', check: null });
    }
  }

  private set(patch: Partial<ExpressionState>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l(this.snap));
  }
}
