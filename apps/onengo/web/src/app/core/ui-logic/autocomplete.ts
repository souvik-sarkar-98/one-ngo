export interface Suggestion {
  id: string;
  label: string;
  /** A second line, e.g. a record number or a definition key. */
  hint?: string;
}

/** Where an autocomplete gets its suggestions: records, definition keys, roles, a fixed list. */
export interface SuggestionSource {
  search(text: string): Promise<Suggestion[]>;
  /** Fewer typed characters than this show no suggestions; 0 suggests on focus. */
  minLength?: number;
}

/** A fixed list, matched on label, hint and id; matches at the start come first. */
export function listSource(items: Suggestion[], limit = 20): SuggestionSource {
  return {
    minLength: 0,
    search: async (text) => {
      const q = text.trim().toLocaleLowerCase();
      if (!q) return items.slice(0, limit);
      const rank = (s: Suggestion) => {
        const hay = [s.label, s.hint ?? '', s.id].map((x) => x.toLocaleLowerCase());
        return hay.some((h) => h.startsWith(q)) ? 0 : hay.some((h) => h.includes(q)) ? 1 : 2;
      };
      return items
        .map((s, i) => ({ s, i, r: rank(s) }))
        .filter((x) => x.r < 2)
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .slice(0, limit)
        .map((x) => x.s);
    },
  };
}

export interface AutocompleteState {
  text: string;
  open: boolean;
  loading: boolean;
  options: Suggestion[];
  /** Index of the highlighted option, -1 for none. */
  active: number;
  error: boolean;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The typing, waiting and choosing of one autocomplete box. Searches run
 * `delay` ms after typing stops; answers to older searches are dropped.
 */
export class AutocompleteSession {
  private snap: AutocompleteState = { text: '', open: false, loading: false, options: [], active: -1, error: false };
  private readonly listeners = new Set<(s: AutocompleteState) => void>();
  private timer: unknown;
  private generation = 0;

  constructor(
    private readonly source: SuggestionSource,
    private readonly delay = 300,
    private readonly timers: Timers = realTimers,
  ) {}

  get snapshot(): AutocompleteState {
    return this.snap;
  }

  subscribe(fn: (s: AutocompleteState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  /** Shows the text without searching, e.g. the chosen value's label. */
  setText(text: string): void {
    this.set({ text });
  }

  input(text: string): void {
    this.set({ text, open: true });
    this.schedule(this.delay);
  }

  /** Focus suggests straight away when the source allows empty searches. */
  focus(): void {
    if ((this.source.minLength ?? 1) === 0 && !this.snap.open) {
      this.set({ open: true });
      this.schedule(0);
    }
  }

  /**
   * Handles a key in the box. Returns whether it was used and, for Enter on a
   * highlighted option, the option chosen.
   */
  key(key: string): { handled: boolean; chosen?: Suggestion } {
    const { open, options, active } = this.snap;
    const last = options.length - 1;
    switch (key) {
      case 'ArrowDown':
        if (!open) {
          this.set({ open: true });
          this.schedule(0);
        } else if (options.length) this.set({ active: active >= last ? 0 : active + 1 });
        return { handled: true };
      case 'ArrowUp':
        if (open && options.length) this.set({ active: active <= 0 ? last : active - 1 });
        return { handled: open };
      case 'Home':
      case 'End':
        if (!open || !options.length) return { handled: false };
        this.set({ active: key === 'Home' ? 0 : last });
        return { handled: true };
      case 'Enter': {
        if (!open || active < 0) return { handled: false };
        const chosen = this.choose(active);
        return chosen ? { handled: true, chosen } : { handled: false };
      }
      case 'Escape':
        if (!open) return { handled: false };
        this.close();
        return { handled: true };
      default:
        return { handled: false };
    }
  }

  highlight(index: number): void {
    if (index >= -1 && index < this.snap.options.length) this.set({ active: index });
  }

  choose(index: number): Suggestion | undefined {
    const chosen = this.snap.options[index];
    if (!chosen) return undefined;
    this.cancel();
    this.set({ text: chosen.label, open: false, loading: false, active: -1 });
    return chosen;
  }

  close(): void {
    this.cancel();
    this.set({ open: false, loading: false, active: -1 });
  }

  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }

  private schedule(ms: number): void {
    this.timers.clear(this.timer);
    this.generation++;
    const text = this.snap.text;
    if (text.trim().length < (this.source.minLength ?? 1)) {
      this.set({ options: [], loading: false, active: -1, error: false });
      return;
    }
    this.set({ loading: true, error: false });
    const run = () => void this.search(text, this.generation);
    if (ms <= 0) run();
    else this.timer = this.timers.set(run, ms);
  }

  private async search(text: string, generation: number): Promise<void> {
    try {
      const options = await this.source.search(text);
      if (generation === this.generation) this.set({ options, loading: false, active: options.length ? 0 : -1, error: false });
    } catch {
      if (generation === this.generation) this.set({ options: [], loading: false, active: -1, error: true });
    }
  }

  private cancel(): void {
    this.timers.clear(this.timer);
    this.timer = undefined;
    this.generation++;
  }

  private set(patch: Partial<AutocompleteState>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l(this.snap));
  }
}
