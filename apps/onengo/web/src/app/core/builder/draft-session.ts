import { t } from '../i18n/i18n';
import type { BuilderDetail, DefinitionKind, Issue } from '../models';
import { makePatch } from '../patch';
import { localChangeLines } from './changes';
import type { BuilderGateway, ChangesAgainst, ChangesResult, CheckResult } from './http-builder';

type Body = Record<string, unknown>;

/**
 * Edits of module definitions waiting to be published. The server keeps no
 * draft for them (their changes are published as a patch in one step), so the
 * draft is kept on the device.
 */
export interface LocalDrafts {
  read(id: string): Body | null;
  write(id: string, body: Body): void;
  remove(id: string): void;
}

export function memoryDrafts(): LocalDrafts {
  const m = new Map<string, Body>();
  return {
    read: (id) => (m.has(id) ? structuredClone(m.get(id)!) : null),
    write: (id, body) => void m.set(id, structuredClone(body)),
    remove: (id) => void m.delete(id),
  };
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface DraftOptions {
  /** Quiet time after the last edit before the draft is saved. */
  delay?: number;
  timers?: Timers;
  now?: () => Date;
  local?: LocalDrafts;
}

/** `saved`: nothing waiting; `pending`: waiting for the quiet time; `saving`: on its way; `failed`: the last save was refused. */
export type SaveState = 'saved' | 'pending' | 'saving' | 'failed';

export interface HistoryRow {
  version: number;
  status: string;
  publishedAt: string | null;
  /** Every version this organisation published and has since replaced can be restored. */
  canRestore: boolean;
}

export interface PublishSummary {
  /** The version publishing creates. */
  version: number;
  lines: string[];
  warnings: Issue[];
  errors: Issue[];
}

export interface DraftSnapshot {
  kind: DefinitionKind;
  key: string;
  loading: boolean;
  /** The definition does not exist, or no longer exists after its only draft was discarded. */
  missing: boolean;
  error: string;
  detail: BuilderDetail | null;
  /** The body being edited: the draft, else the published version. */
  body: Body | null;
  /** Comes from a module; changes are published as the organisation's patch. */
  shipped: boolean;
  /** A module definition the organisation has changed. */
  patched: boolean;
  /** There are changes not yet published. */
  hasDraft: boolean;
  save: SaveState;
  savedAt: string | null;
  saveIssues: Issue[];
  checking: boolean;
  check: CheckResult | null;
  changesAgainst: ChangesAgainst;
  changesLoading: boolean;
  changes: ChangesResult | null;
  summary: PublishSummary | null;
  busy: boolean;
  history: HistoryRow[];
  /** What the last finished action did, for a short confirmation. */
  message: string;
}

function messageOf(e: unknown, fallback: string): string {
  return e && typeof e === 'object' && 'message' in e && 'code' in e ? String((e as { message: unknown }).message) : fallback;
}

function issuesOf(e: unknown): Issue[] {
  const issues = e && typeof e === 'object' && 'issues' in e ? (e as { issues: unknown }).issues : undefined;
  return Array.isArray(issues) ? (issues as Issue[]) : [];
}

const codeOf = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One definition open in the Builder: loads the published version, the
 * draft, the module's base and the history; saves the draft a moment after
 * each edit; checks, reviews, publishes, discards, restores and reverts.
 * Every rule stays on the server; this only keeps the screen in step with it.
 */
export class DraftSession {
  private snap: DraftSnapshot;
  private readonly listeners = new Set<(s: DraftSnapshot) => void>();
  private readonly delay: number;
  private readonly timers: Timers;
  private readonly now: () => Date;
  private readonly local: LocalDrafts;
  private timer: unknown = null;
  private revision = 0;
  private savedRevision = 0;
  private saving: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly gateway: BuilderGateway,
    readonly kind: DefinitionKind,
    readonly key: string,
    opts: DraftOptions = {},
  ) {
    this.delay = opts.delay ?? 800;
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? (() => new Date());
    this.local = opts.local ?? memoryDrafts();
    this.snap = {
      kind,
      key,
      loading: true,
      missing: false,
      error: '',
      detail: null,
      body: null,
      shipped: false,
      patched: false,
      hasDraft: false,
      save: 'saved',
      savedAt: null,
      saveIssues: [],
      checking: false,
      check: null,
      changesAgainst: 'published',
      changesLoading: false,
      changes: null,
      summary: null,
      busy: false,
      history: [],
      message: '',
    };
  }

  get snapshot(): DraftSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: DraftSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snap);
    return () => this.listeners.delete(fn);
  }

  private get localId(): string {
    return `${this.kind}/${this.key}`;
  }

  private get published(): Body | null {
    return this.snap.detail?.published?.body ?? null;
  }

  async load(): Promise<void> {
    this.set({ loading: true, error: '', missing: false });
    try {
      const detail = await this.gateway.detail(this.kind, this.key);
      const local = detail.shipped ? this.local.read(this.localId) : null;
      const body = structuredClone(local ?? detail.draft?.body ?? detail.published?.body ?? null);
      this.revision = this.savedRevision = 0;
      this.set({ loading: false, body, check: null, changes: null, ...this.fromDetail(detail, !!local) });
    } catch (e) {
      this.set({ loading: false, missing: codeOf(e) === 'not_found', error: codeOf(e) === 'not_found' ? '' : messageOf(e, t('ui.builder.loadOneFailed')) });
    }
  }

  private fromDetail(detail: BuilderDetail, localDraft: boolean): Partial<DraftSnapshot> {
    const shipped = !!detail.shipped;
    const history = [...detail.history]
      .sort((a, b) => b.version - a.version)
      .map((h) => ({
        version: h.version,
        status: h.status,
        publishedAt: h.published_at,
        canRestore: h.status === 'superseded' && !!h.published_at,
      }));
    const patch = detail.shipped?.patch;
    return {
      detail,
      shipped,
      patched: shipped && patch !== null && patch !== undefined && !same(patch, {}),
      hasDraft: shipped ? localDraft : !!detail.draft,
      history,
    };
  }

  /** Takes the edited body and saves it once editing pauses. */
  edit(body: Body): void {
    if (this.disposed) return;
    this.revision++;
    this.set({ body: structuredClone(body), save: 'pending', check: null, message: '' });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  /** Saves at once anything waiting: on blur, before leaving, and before checking or publishing. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    while (this.saving) await this.saving;
    if (this.revision === this.savedRevision || !this.snap.body) return;
    this.saving = this.saveNow().finally(() => (this.saving = null));
    await this.saving;
  }

  private async saveNow(): Promise<void> {
    const revision = this.revision;
    const body = this.snap.body!;
    this.set({ save: 'saving' });
    try {
      if (this.snap.shipped) {
        const changed = !same(body, this.published);
        if (changed) this.local.write(this.localId, body);
        else this.local.remove(this.localId);
        this.savedRevision = revision;
        this.set({ hasDraft: changed });
      } else {
        await this.gateway.saveDraft(this.kind, this.key, body);
        this.savedRevision = revision;
        if (!this.snap.detail?.draft) await this.refresh();
      }
      const pending = this.revision !== this.savedRevision;
      this.set({ save: pending ? 'pending' : 'saved', savedAt: this.now().toISOString(), saveIssues: [], error: '' });
      if (pending && !this.disposed) this.schedule();
    } catch (e) {
      this.set({ save: 'failed', error: messageOf(e, t('ui.builder.saveFailed')), saveIssues: issuesOf(e) });
    }
  }

  /** Saves what is waiting; false when the draft could not be saved, so nothing older is published. */
  private async saved(): Promise<boolean> {
    await this.flush();
    return this.snap.save !== 'failed';
  }

  private async refresh(): Promise<void> {
    const detail = await this.gateway.detail(this.kind, this.key);
    this.set(this.fromDetail(detail, this.snap.shipped && !!this.local.read(this.localId)));
  }

  /** The patch that turns the module's version into the body being edited. */
  private patch(): Record<string, unknown> {
    const patch = makePatch(this.snap.detail?.shipped?.base, this.snap.body);
    return patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  }

  async check(): Promise<CheckResult | null> {
    await this.flush();
    this.set({ checking: true, error: '' });
    try {
      const check = await this.gateway.check(this.kind, this.key, this.snap.shipped ? { patch: this.patch() } : this.snap.body);
      this.set({ checking: false, check });
      return check;
    } catch (e) {
      this.set({ checking: false, error: messageOf(e, t('ui.common.somethingWentWrong')) });
      return null;
    }
  }

  /**
   * The Changes tab. A module definition's unpublished edits live on the
   * device, so its draft-against-published lines are worked out here.
   */
  async loadChanges(against: ChangesAgainst = this.snap.changesAgainst): Promise<void> {
    await this.flush();
    this.set({ changesAgainst: against, changesLoading: true, error: '' });
    try {
      const changes =
        against === 'published' && this.snap.shipped
          ? this.localChanges()
          : await this.gateway.changes(this.kind, this.key, against);
      this.set({ changesLoading: false, changes });
    } catch (e) {
      this.set({ changesLoading: false, changes: null, error: messageOf(e, t('ui.common.loadFailed')) });
    }
  }

  private localChanges(): ChangesResult {
    const published = this.snap.detail?.published;
    return {
      against: 'published',
      from: published ? { version: published.version, module: false } : null,
      to: { version: null, draft: this.snap.hasDraft },
      lines: localChangeLines(this.published, this.snap.body),
      warnings: [],
    };
  }

  private nextVersion(): number {
    const d = this.snap.detail;
    if (!this.snap.shipped && d?.draft) return d.draft.version;
    return Math.max(0, d?.draft?.version ?? 0, ...(d?.history ?? []).map((h) => h.version)) + 1;
  }

  /** Saves, then gathers what publishing would change and any problems, for the publish panel. */
  async openPublish(): Promise<void> {
    if (!(await this.saved())) return;
    this.set({ busy: true, error: '', message: '' });
    try {
      const shipped = this.snap.shipped;
      const [check, changes] = await Promise.all([
        this.gateway.check(this.kind, this.key, shipped ? { patch: this.patch() } : undefined),
        shipped ? Promise.resolve(this.localChanges()) : this.gateway.changes(this.kind, this.key, 'published'),
      ]);
      const warnings = [...changes.warnings, ...check.warnings.filter((w) => !changes.warnings.some((c) => c.path === w.path && c.message === w.message))];
      this.set({ busy: false, check, summary: { version: this.nextVersion(), lines: changes.lines, warnings, errors: check.errors } });
    } catch (e) {
      this.set({ busy: false, error: messageOf(e, t('ui.common.somethingWentWrong')), saveIssues: issuesOf(e) });
    }
  }

  closePublish(): void {
    this.set({ summary: null });
  }

  async publish(): Promise<boolean> {
    if (!(await this.saved())) return false;
    return this.run(async () => {
      if (this.snap.shipped) {
        await this.gateway.savePatch(this.kind, this.key, this.patch());
        this.local.remove(this.localId);
      } else await this.gateway.publish(this.kind, this.key);
      await this.reload();
      return t('ui.builder.publishedLive');
    });
  }

  /** Drops the unpublished changes. A definition that was never published is gone afterwards. */
  async discard(): Promise<boolean> {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    while (this.saving) await this.saving;
    this.savedRevision = this.revision;
    return this.run(async () => {
      if (this.snap.shipped) this.local.remove(this.localId);
      else if (this.snap.detail?.draft) await this.gateway.discard(this.kind, this.key);
      if (!this.snap.shipped && !this.snap.detail?.published) {
        this.set({ missing: true, body: null, detail: null, hasDraft: false });
        return t('ui.builder.draftDiscarded');
      }
      await this.reload();
      return t('ui.builder.draftDiscarded');
    });
  }

  /** Publishes an earlier version again as the newest one, dropping unpublished changes. */
  async restore(version: number): Promise<boolean> {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    while (this.saving) await this.saving;
    this.savedRevision = this.revision;
    return this.run(async () => {
      if (this.snap.shipped) this.local.remove(this.localId);
      await this.gateway.rollback(this.kind, this.key, version);
      await this.reload();
      return t('ui.builder.restored', { version });
    });
  }

  /** Drops the organisation's changes to a module definition, published at once. */
  async revertToModule(): Promise<boolean> {
    if (!this.snap.shipped) return false;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    while (this.saving) await this.saving;
    this.savedRevision = this.revision;
    return this.run(async () => {
      await this.gateway.savePatch(this.kind, this.key, {});
      this.local.remove(this.localId);
      await this.reload();
      return t('ui.builder.reverted');
    });
  }

  private async reload(): Promise<void> {
    const detail = await this.gateway.detail(this.kind, this.key);
    const local = detail.shipped ? this.local.read(this.localId) : null;
    this.revision = this.savedRevision = 0;
    this.set({
      body: structuredClone(local ?? detail.draft?.body ?? detail.published?.body ?? null),
      save: 'saved',
      saveIssues: [],
      summary: null,
      check: null,
      changes: null,
      ...this.fromDetail(detail, !!local),
    });
  }

  private async run(action: () => Promise<string>): Promise<boolean> {
    this.set({ busy: true, error: '', message: '' });
    try {
      const message = await action();
      this.set({ busy: false, message });
      return true;
    } catch (e) {
      this.set({ busy: false, error: messageOf(e, t('ui.common.somethingWentWrong')), saveIssues: issuesOf(e) });
      return false;
    }
  }

  /** Saves what is waiting and stops; nothing is scheduled afterwards. */
  async dispose(): Promise<void> {
    await this.flush();
    this.disposed = true;
    this.listeners.clear();
  }

  private set(change: Partial<DraftSnapshot>): void {
    this.snap = { ...this.snap, ...change };
    for (const fn of this.listeners) fn(this.snap);
  }
}
