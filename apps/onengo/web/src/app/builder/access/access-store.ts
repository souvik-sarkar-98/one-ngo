import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { AccessDrafts, elementId, type AccessDraftsSnapshot } from '../../core/builder/access-drafts';
import { accessParams, accessView, parseAccessAddress, roleSummary, withChanges, type AccessAddress, type RoleInfo } from '../../core/builder/access-map';
import { rolePreview } from '../../core/builder/access-preview';
import { httpAccess, type AccessMap, type AccessMapElement } from '../../core/builder/http-access';
import { httpBuilder } from '../../core/builder/http-builder';
import { httpEditor } from '../../core/builder/http-editor';
import { t } from '../../core/i18n/i18n';
import type { SuggestionSource } from '../../core/ui-logic/autocomplete';
import { Api } from '../../services/api';
import { ScreenMeta } from '../../services/screen-meta';
import { Session } from '../../services/session';
import { Viewport } from '../../ui/viewport';
import { browserDrafts } from '../builder-store';

function messageOf(e: unknown, fallback: string): string {
  return e && typeof e === 'object' && 'message' in e && 'code' in e ? String((e as { message: unknown }).message) : fallback;
}

/**
 * The access map (Builder 24) and its role view (Builder 25). Inline changes
 * become drafts of the definitions they belong to and are published
 * together. The only place the access screens reach the router and the server.
 */
@Injectable()
export class AccessStore {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(Session);
  private readonly meta = inject(ScreenMeta);
  private readonly api = inject(Api);
  private readonly gateway = httpAccess(this.api);
  private readonly editor = httpEditor(this.api);
  private readonly drafts = new AccessDrafts(httpBuilder(this.api), { local: browserDrafts(this.session.me()?.tenant.key ?? '') });
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded: string | null = null;

  readonly narrow = inject(Viewport).narrow;
  readonly address = signal<AccessAddress>({ area: 'all', q: '', problems: false });
  readonly searchText = signal('');
  readonly map = signal<AccessMap | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly roles = signal<RoleInfo[]>([]);
  readonly draft = signal<AccessDraftsSnapshot>(this.drafts.snapshot);
  /** The row whose permission is being changed, and what has been typed so far. */
  readonly editing = signal<{ id: string; value: string } | null>(null);
  /** The record type drawn in the role view's preview. */
  readonly previewType = signal<string | null>(null);

  readonly canEdit = computed(() => !!this.session.me()?.capabilities.publish && !this.narrow());
  readonly canEditRoles = computed(() => !!this.session.me()?.capabilities.roles);
  /** Who holds what, the "held by" filter, the role view and the problems list need `admin:roles`; the server sends no holders without it. */
  readonly showRoles = this.canEditRoles;
  /** The role in the address, which only counts for people who may see roles. */
  private readonly roleKey = computed(() => (this.showRoles() ? this.address().role : undefined));
  readonly recordTypes = computed(() => (this.session.defs()?.recordTypes ?? []).map((x) => ({ key: x.key, label: x.pluralLabel ?? x.label })));
  readonly role = computed(() => {
    const key = this.roleKey();
    return key ? (this.roles().find((r) => r.key === key) ?? { key, label: this.map()?.role?.label ?? key }) : null;
  });
  readonly elements = computed(() => withChanges(this.map()?.elements ?? [], this.draft().pending, this.roles(), this.roleKey()));
  readonly view = computed(() =>
    accessView(this.elements(), this.address(), {
      roles: this.roles(),
      recordTypes: this.recordTypes(),
      changed: new Set(this.draft().pending.map((p) => p.id)),
      showRoles: this.showRoles(),
    }),
  );
  readonly summary = computed(() => (this.roleKey() && this.map()?.role ? roleSummary(this.elements(), this.recordTypes()) : null));
  readonly preview = computed(() => {
    const defs = this.session.defs();
    const key = this.previewType() ?? this.summary()?.records.find((r) => r.visible)?.key ?? defs?.recordTypes[0]?.key;
    const type = defs?.recordTypes.find((x) => x.key === key);
    if (!defs || !type || !this.summary()) return null;
    return rolePreview({
      type,
      workflow: defs.workflows[type.key],
      workflows: defs.workflowSets?.[type.key],
      view: defs.listViews?.[type.key],
      actions: defs.actions?.[type.key],
      elements: this.elements(),
    });
  });
  readonly permissionSource: SuggestionSource = {
    minLength: 0,
    search: async (q) => (await this.editor.permissionSuggestions(q)).map((s) => ({ id: s.permission, label: s.permission, hint: s.label })),
  };

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      const a = parseAccessAddress((n) => p.get(n));
      this.address.set(a);
      if (this.searchTimer === undefined) this.searchText.set(a.q);
    });
    const detach = this.drafts.subscribe((s) => this.draft.set(s));
    effect(() => {
      const role = this.roleKey() ?? '';
      untracked(() => {
        if (role !== this.loaded) void this.load(role);
      });
    });
    effect(() => {
      const r = this.role();
      untracked(() => this.meta.crumbLabels.set(r ? { role: r.label } : {}));
    });
    void this.loadRoles();
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.searchTimer);
      detach();
      this.meta.clear();
      void this.drafts.dispose();
    });
  }

  async load(role = this.roleKey() ?? ''): Promise<void> {
    this.loaded = role;
    this.loading.set(true);
    this.error.set('');
    try {
      this.map.set(await this.gateway.accessMap(role ? { role } : {}));
    } catch (e) {
      this.error.set(messageOf(e, t('ui.common.loadFailed')));
    } finally {
      this.loading.set(false);
    }
  }

  /** Role names for everyone; their permissions only for people who may manage roles, to work out changes before publishing. */
  private async loadRoles(): Promise<void> {
    try {
      this.roles.set(this.canEditRoles() ? await this.gateway.roles() : await this.editor.roles());
    } catch {
      this.roles.set([]);
    }
  }

  selectArea(id: string): void {
    this.replace({ area: id as AccessAddress['area'] });
  }

  search(text: string): void {
    this.searchText.set(text);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      this.replace({ q: text });
    }, 300);
  }

  setRecordType(key: string): void {
    this.replace({ recordType: key });
  }

  setHeldBy(key: string): void {
    this.replace({ heldBy: key });
  }

  setProblems(on: boolean): void {
    this.replace({ problems: on });
  }

  openRoleView(key: string): void {
    this.previewType.set(null);
    void this.router.navigate(['/builder/access'], { queryParams: accessParams({ role: key }), queryParamsHandling: 'merge' });
  }

  closeRoleView(): void {
    void this.router.navigate(['/builder/access'], { queryParams: accessParams({ role: undefined }), queryParamsHandling: 'merge' });
  }

  editRole(key: string): void {
    void this.router.navigate(['/admin/roles', key], { queryParams: { tab: 'permissions' } });
  }

  startEdit(e: AccessMapElement): void {
    this.editing.set({ id: elementId(e), value: e.permission ?? '' });
  }

  type(value: string): void {
    const current = this.editing();
    if (current) this.editing.set({ ...current, value });
  }

  cancelEdit(): void {
    this.editing.set(null);
  }

  async applyEdit(e: AccessMapElement): Promise<void> {
    const current = this.editing();
    if (!current) return;
    if (await this.drafts.change(e, current.value)) this.editing.set(null);
  }

  async check(): Promise<void> {
    await this.drafts.checkAll();
  }

  async publish(): Promise<void> {
    if (!(await this.drafts.publishAll())) return;
    await this.session.reload();
    await this.load();
  }

  async discard(): Promise<void> {
    await this.drafts.discardAll();
  }

  private replace(change: Partial<AccessAddress>): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: accessParams(change), queryParamsHandling: 'merge', replaceUrl: true });
  }
}
