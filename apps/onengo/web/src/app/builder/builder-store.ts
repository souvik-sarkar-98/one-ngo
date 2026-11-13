import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { parseEditorAddress, selectionParams, tabParams, type EditorAddress, type EditorTab } from '../core/builder/address';
import { selectionLabel } from '../core/builder/crumbs';
import { DraftSession, type DraftSnapshot, type LocalDrafts } from '../core/builder/draft-session';
import { expressionAssist } from '../core/builder/expression-assist';
import type { ChangesAgainst } from '../core/builder/http-builder';
import { httpBuilder } from '../core/builder/http-builder';
import { intlLocale } from '../core/i18n/i18n';
import type { DefinitionKind } from '../core/models';
import { httpGateway } from '../core/records/gateway/http-gateway';
import { Api } from '../services/api';
import { I18n } from '../services/i18n';
import { ScreenMeta } from '../services/screen-meta';
import { Session } from '../services/session';
import { Viewport } from '../ui/viewport';

type Body = Record<string, unknown>;

/** Module definitions' unpublished edits, kept per organisation in this browser. */
export function browserDrafts(tenant: string): LocalDrafts {
  const id = (key: string) => `ngo.builder.draft.${tenant}.${key}`;
  return {
    read: (key) => {
      try {
        const raw = localStorage.getItem(id(key));
        return raw ? (JSON.parse(raw) as Body) : null;
      } catch {
        return null;
      }
    },
    write: (key, body) => localStorage.setItem(id(key), JSON.stringify(body)),
    remove: (key) => localStorage.removeItem(id(key)),
  };
}

/**
 * Angular wrapper around one definition's draft session: exposes it as
 * signals, keeps the tab and selection in the address bar, and gives the
 * shell the breadcrumb labels. The only place the editor reaches the router.
 */
@Injectable()
export class BuilderStore {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(Session);
  private readonly meta = inject(ScreenMeta);
  private readonly i18n = inject(I18n);
  private draft: DraftSession | null = null;
  private detach: (() => void) | null = null;

  readonly gateway = httpBuilder(inject(Api));
  /** Suggestions, the live check and "Try it" for every expression field of the editor. */
  readonly expressions = expressionAssist(this.gateway, httpGateway(inject(Api)));
  readonly state = signal<DraftSnapshot | null>(null);
  readonly address = signal<EditorAddress>({ tab: 'visual', create: false });
  readonly narrow = inject(Viewport).narrow;

  readonly body = computed(() => this.state()?.body ?? null);
  readonly title = computed(() => {
    const s = this.state();
    const label = s?.body?.['label'];
    return typeof label === 'string' && label ? label : (s?.key ?? '');
  });
  readonly canPublish = computed(() => {
    const caps = this.session.me()?.capabilities;
    return this.state()?.kind === 'script' ? !!caps?.scripts : !!caps?.publish;
  });
  /** Phones and people who may not publish see a read-only summary. */
  readonly canEdit = computed(() => !this.narrow() && this.canPublish());
  readonly savedTime = computed(() => {
    const at = this.state()?.savedAt;
    return at ? new Date(at).toLocaleTimeString(intlLocale(this.i18n.locale()), { hour: '2-digit', minute: '2-digit' }) : '';
  });

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => this.address.set(parseEditorAddress((n) => p.get(n))));
    effect(() => {
      const a = this.address();
      const s = this.state();
      untracked(() => {
        if (a.tab === 'changes' && s && !s.loading && !s.missing && !s.changes && !s.changesLoading && !s.error) void this.draft?.loadChanges();
      });
    });
    effect(() => {
      this.i18n.locale();
      const title = this.title();
      const selection = selectionLabel(this.body(), this.address());
      untracked(() => {
        this.meta.crumbLabels.set(title ? { definition: title } : {});
        this.meta.crumbLabel.set(selection);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.meta.clear();
      this.detach?.();
      void this.draft?.dispose();
    });
  }

  use(kind: DefinitionKind, key: string): void {
    this.detach?.();
    void this.draft?.dispose();
    const draft = new DraftSession(this.gateway, kind, key, { local: browserDrafts(this.session.me()?.tenant.key ?? '') });
    this.draft = draft;
    this.detach = draft.subscribe((s) => this.state.set(s));
    void draft.load();
  }

  selectTab(tab: EditorTab): void {
    if (tab === this.address().tab) return;
    this.navigate(tabParams(tab));
  }

  /**
   * Opens or closes the selected part. The first open adds a history entry, so
   * Back closes it. Closing it, moving to another part, or `replace` (the key
   * following its label while typing) keeps that one entry.
   */
  select(sel: { field?: string; step?: string; section?: string; widget?: string; create?: boolean }, replace = false): void {
    const current = this.address();
    const open = (s: { field?: string; step?: string; section?: string; widget?: string; create?: boolean }) => !!(s.field || s.step || s.section || s.widget || s.create);
    this.navigate(selectionParams(sel), replace || !(!open(current) && open(sel)));
  }

  edit(body: Body): void {
    this.draft?.edit(body);
  }

  flush(): void {
    void this.draft?.flush();
  }

  check(): void {
    void this.draft?.check();
  }

  showChanges(against: ChangesAgainst): void {
    void this.draft?.loadChanges(against);
  }

  openPublish(): void {
    void this.draft?.openPublish();
  }

  closePublish(): void {
    this.draft?.closePublish();
  }

  async publish(): Promise<void> {
    if (await this.draft?.publish()) await this.session.reload();
  }

  async discard(): Promise<void> {
    if (!(await this.draft?.discard())) return;
    if (this.state()?.missing) await this.router.navigate(['/builder'], { queryParams: { kind: this.state()?.kind } });
  }

  async restore(version: number): Promise<void> {
    if (await this.draft?.restore(version)) await this.session.reload();
  }

  async revert(): Promise<void> {
    if (await this.draft?.revertToModule()) await this.session.reload();
  }

  openDefinition(kind: DefinitionKind, key: string): void {
    void this.router.navigate(['/builder', kind, key]);
  }

  backToCatalogue(): void {
    void this.router.navigate(['/builder'], { queryParams: { kind: this.state()?.kind } });
  }

  /** Opens the kind page with the create sheet filled in as a copy of this definition. */
  duplicate(): void {
    const current = this.state();
    if (!current) return;
    void this.router.navigate(['/builder'], { queryParams: { kind: current.kind, copy: current.key } });
  }

  private navigate(queryParams: Record<string, string | null>, replaceUrl = false): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl });
  }
}
