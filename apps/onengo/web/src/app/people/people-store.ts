import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { formatDate, t } from '../core/i18n/i18n';
import type { PeopleAddress, PeopleVariant } from '../core/people/address';
import { httpPeopleList } from '../core/people/http-people';
import type { PersonItem } from '../core/people/people';
import { PeopleSession, type BulkPeopleOperation, type PeopleMeta, type PeopleSnapshot } from '../core/people/people-session';
import { directorySections, joinedText, peopleColumns, peopleFilters, peoplePills, peopleSortOptions, personRow, roleNames, statusChips, twoStepLabel } from '../core/people/rows';
import { focusFirstInvalid } from '../core/records/record/focus-invalid';
import { splitIssues, type FormValues } from '../core/records/record/forms';
import type { CfFieldDef } from '../ui/cf-types';
import type { DetailSection } from '../core/records/record/present';
import { NO_SELECTION, type Selection } from '../core/records/bulk/selection';
import { listSource, type Suggestion } from '../core/ui-logic/autocomplete';
import type { Notice } from '../records/notice';
import { DebouncedSearch } from '../records/search';
import { Api } from '../services/api';
import { I18n } from '../services/i18n';
import { ScreenMeta } from '../services/screen-meta';
import { Viewport } from '../ui/viewport';

const EMPTY: PeopleSnapshot = { items: [], total: 0, loading: true, loadingMore: false, hasMore: false, error: '' };

/**
 * Angular wrapper around the People screen: the session for the variant the
 * route names, the open person, Add a person, and bulk operations. It reads
 * the address bar, writes every intent back to it, and is the only place the
 * screen reaches the router or the server.
 */
@Injectable()
export class PeopleStore {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly i18n = inject(I18n);
  private readonly meta = inject(ScreenMeta);
  private readonly api = inject(Api);
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  readonly variant: PeopleVariant = this.route.snapshot.data['variant'] === 'directory' ? 'directory' : 'management';
  readonly people = new PeopleSession(this.variant, httpPeopleList(this.api), {
    navigate: (queryParams, replaceUrl) => void this.router.navigate([], { relativeTo: this.route, queryParams, queryParamsHandling: 'merge', replaceUrl }),
  });
  readonly manages = this.variant === 'management';

  readonly state = signal<PeopleAddress>(this.people.state);
  readonly rows = signal<PeopleSnapshot>(EMPTY);
  readonly info = signal<PeopleMeta>(this.people.meta);
  readonly selection = signal<Selection>(NO_SELECTION);
  readonly notice = signal<Notice | null>(null);
  readonly filtersOpen = signal(false);
  readonly busy = signal(false);
  /** The person whose ⋮ chose Change roles: their panel opens on the roles. */
  readonly highlight = signal<string | null>(null);

  readonly narrow = inject(Viewport).narrow;
  readonly layout = computed(() => (this.narrow() ? 'cards' : 'table'));
  readonly chips = computed(() => {
    this.i18n.locale();
    return this.manages ? statusChips(this.info().counts) : [];
  });
  readonly columns = computed(() => {
    this.i18n.locale();
    return peopleColumns(this.variant);
  });
  readonly sortOptions = computed(() => {
    this.i18n.locale();
    return peopleSortOptions(this.variant);
  });
  readonly sort = computed(() => this.state().sort ?? { field: 'name', dir: 'asc' as const });
  readonly rowViews = computed(() => {
    this.i18n.locale();
    const info = this.info();
    return this.rows().items.map((p) => personRow(p, this.variant, info));
  });
  readonly filters = computed(() => {
    this.i18n.locale();
    return peopleFilters(this.variant, this.info());
  });
  readonly pills = computed(() => peoplePills(this.state(), this.filters()));
  readonly filterFields = computed<CfFieldDef[]>(() =>
    this.filters().map((f) => ({ key: f.key, label: f.label, type: 'multiselect', required: false, readOnly: false, options: f.options })),
  );
  readonly filterValues = computed<FormValues>(() => ({ role: this.state().role }));
  readonly checked = computed(() => (this.manages ? new Set(this.selection().ids) : null));
  readonly selecting = computed(() => this.manages && this.selection().selecting);
  readonly selectedCount = computed(() => this.selection().ids.length);
  readonly listMenu = computed(() =>
    this.manages && !this.selecting() ? [{ id: 'select', label: t('ui.bulk.select'), disabled: this.rows().total === 0 }] : [],
  );

  readonly search = new DebouncedSearch(() => this.people);

  // ------------------------------------------------------------- person panel

  readonly person = signal<PersonItem | null>(null);
  readonly personError = signal('');
  readonly roleDraft = signal<string[]>([]);
  readonly confirmingSuspend = signal(false);

  /** The page's notice, repeated inside the person panel, which covers the page. */
  readonly panelNotice = computed(() => {
    const n = this.notice();
    return n && n.level !== 'error' ? n.message : '';
  });
  readonly panelError = computed(() => (this.notice()?.level === 'error' ? this.notice()!.message : ''));

  readonly personTitle = computed(() => this.person()?.displayName ?? (this.state().person ? t('ui.crumbs.person') : ''));
  readonly suspended = computed(() => this.person()?.status === 'suspended');
  readonly sections = computed<DetailSection[]>(() => {
    this.i18n.locale();
    const p = this.person();
    if (!p) return [];
    if (!this.manages) return directorySections(p, this.info());
    const signIn: DetailSection = {
      kind: 'fields',
      id: 'signIn',
      title: t('ui.people.signIn'),
      fields: [
        { label: t('ui.people.col.status'), value: t(`ui.people.status.${p.status ?? 'active'}`) },
        { label: t('ui.people.col.twoStep'), value: twoStepLabel(p.twoStep) },
        { label: t('ui.people.col.joined'), value: joinedText(p) },
        { label: t('ui.people.lastSignIn'), value: p.lastSignedInAt ? formatDate(p.lastSignedInAt) : t('ui.people.never') },
        { label: t('ui.people.lastInvite'), value: p.invitedAt ? formatDate(p.invitedAt) : '—' },
      ],
    };
    return [signIn];
  });
  readonly roleOptions = computed(() => this.info().roles);
  readonly roleSource = computed(() => listSource(this.info().roles.filter((r) => !this.roleDraft().includes(r.key)).map((r) => ({ id: r.key, label: r.label }))));
  readonly rolesChanged = computed(() => {
    const p = this.person();
    return !!p && [...this.roleDraft()].sort().join() !== [...p.roles].sort().join();
  });
  // ------------------------------------------------------------------ add

  readonly addEmail = signal('');
  readonly addName = signal('');
  readonly addRoles = signal<string[]>([]);
  readonly addInvite = signal(true);
  readonly addErrors = signal<Record<string, string>>({});
  readonly addSource = computed(() => listSource(this.info().roles.filter((r) => !this.addRoles().includes(r.key)).map((r) => ({ id: r.key, label: r.label }))));

  // ----------------------------------------------------------------- bulk

  readonly bulkOp = signal<BulkPeopleOperation | null>(null);
  readonly bulkRole = signal('');
  readonly bulkOperations = computed(() => {
    this.i18n.locale();
    return [
      { id: 'addRole', label: t('ui.people.bulkAddRole') },
      { id: 'removeRole', label: t('ui.people.bulkRemoveRole') },
      { id: 'resend', label: t('ui.people.resend') },
      { id: 'suspend', label: t('ui.people.suspend') },
    ];
  });

  constructor() {
    const detach = [
      this.people.onState((s) => this.state.set(s)),
      this.people.controller.subscribe((s) => this.rows.set(s)),
      this.people.onMeta((m) => this.info.set(m)),
      this.people.onSelection((s) => this.selection.set(s)),
    ];
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => void this.people.fromUrl((n) => p.get(n), p.keys));
    effect(() => this.search.sync(this.state().q));
    effect(() => {
      const id = this.state().person;
      untracked(() => void this.loadPerson(id));
    });
    effect(() => {
      const id = this.state().person;
      const loaded = this.rows().items.length;
      if (id && loaded && !this.manages && !untracked(() => this.person())) untracked(() => void this.loadPerson(id));
    });
    effect(() => {
      const add = this.state().add;
      if (add) untracked(() => this.resetAdd());
    });
    effect(() => {
      const name = this.person()?.displayName;
      const add = this.state().add;
      untracked(() => {
        this.meta.crumbLabels.set(name ? { person: name } : {});
        this.meta.crumbLabel.set(add ? t('ui.crumbs.addPerson') : null);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      detach.forEach((d) => d());
      this.search.dispose();
      clearTimeout(this.noticeTimer);
      this.meta.clear();
    });
  }

  // ---------------------------------------------------------------- list

  selectChip(id: string): void {
    this.people.selectChip(id);
  }

  toggleSort(field: string): void {
    this.people.toggleSort(field);
  }

  loadMore(): void {
    this.people.loadMore();
  }

  retry(): void {
    void this.people.retry();
  }

  open(id: string): void {
    this.people.open(id);
  }

  openFilters(): void {
    this.filtersOpen.set(true);
  }

  closeFilters(): void {
    this.filtersOpen.set(false);
  }

  applyFilters(values: FormValues): void {
    this.filtersOpen.set(false);
    const pick = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    this.people.applyFilters(Object.fromEntries(this.filters().map((f) => [f.key, pick(values[f.key])])));
  }

  removeFilter(id: string): void {
    this.people.removeFilter(id);
  }

  clearFilters(): void {
    this.filtersOpen.set(false);
    this.people.clearFilters();
  }

  chooseMenu(id: string): void {
    if (id === 'select') this.people.startSelecting();
  }

  check(id: string): void {
    this.people.check(id);
  }

  checkPage(): void {
    this.people.checkPage();
  }

  press(id: string): void {
    this.people.press(id);
  }

  clearSelection(): void {
    this.people.clearSelection();
  }

  /** The row ⋮: Change roles opens the person, Resend and Reactivate run at once, Suspend asks in the panel. */
  rowAction(id: string, action: string): void {
    if (action === 'resend') void this.run(() => this.people.resend(id));
    else if (action === 'reactivate') void this.run(() => this.people.reactivate(id));
    else {
      this.highlight.set(action === 'roles' ? id : null);
      this.people.open(id);
      if (action === 'suspend') this.confirmingSuspend.set(true);
    }
  }

  // --------------------------------------------------------------- person

  close(): void {
    this.people.close();
  }

  addRoleToDraft(s: Suggestion): void {
    this.roleDraft.update((r) => (r.includes(s.id) ? r : [...r, s.id]));
  }

  removeRoleFromDraft(key: string): void {
    this.roleDraft.update((r) => r.filter((x) => x !== key));
  }

  roleLabel(key: string): string {
    return roleNames([key], this.info().roles);
  }

  async saveRoles(): Promise<void> {
    const p = this.person();
    if (!p) return;
    const out = await this.run(() => this.people.setRoles(p.userId, this.roleDraft()));
    if (out) await this.loadPerson(p.userId);
    else this.roleDraft.set([...p.roles]);
  }

  async resend(): Promise<void> {
    const p = this.person();
    if (p) await this.run(() => this.people.resend(p.userId));
  }

  askSuspend(): void {
    this.confirmingSuspend.set(true);
  }

  cancelSuspend(): void {
    this.confirmingSuspend.set(false);
  }

  async confirmSuspend(): Promise<void> {
    const p = this.person();
    if (!p) return;
    this.confirmingSuspend.set(false);
    if (await this.run(() => this.people.suspend(p.userId))) await this.loadPerson(p.userId);
  }

  async reactivate(): Promise<void> {
    const p = this.person();
    if (p && (await this.run(() => this.people.reactivate(p.userId)))) await this.loadPerson(p.userId);
  }

  // ------------------------------------------------------------------ add

  openAdd(): void {
    this.people.openAdd();
  }

  addRole(s: Suggestion): void {
    this.addRoles.update((r) => (r.includes(s.id) ? r : [...r, s.id]));
  }

  removeAddRole(key: string): void {
    this.addRoles.update((r) => r.filter((x) => x !== key));
  }

  async saveAdd(): Promise<void> {
    if (this.busy()) return;
    const errors: Record<string, string> = {};
    if (!this.addEmail().trim()) errors['email'] = t('ui.records.required', { field: t('ui.people.col.email') });
    if (!this.addName().trim()) errors['displayName'] = t('ui.records.required', { field: t('ui.people.col.name') });
    if (!this.addRoles().length) errors['roles'] = t('ui.people.chooseRole');
    this.addErrors.set(errors);
    if (Object.keys(errors).length) {
      focusFirstInvalid();
      return;
    }
    this.busy.set(true);
    const out = await this.people.add({ email: this.addEmail().trim(), displayName: this.addName().trim(), roles: this.addRoles(), invite: this.addInvite() });
    this.busy.set(false);
    if (out.ok) {
      this.highlight.set(out.userId ?? null);
      this.show({ level: 'success', message: out.message });
    } else {
      const { fields } = splitIssues(out.message, out.issues ?? []);
      this.addErrors.set(Object.keys(fields).length ? fields : { email: out.message });
      focusFirstInvalid();
    }
  }

  // ----------------------------------------------------------------- bulk

  openBulk(id: string): void {
    const op = id as BulkPeopleOperation;
    if (op === 'resend') void this.runBulk(op);
    else {
      this.bulkRole.set('');
      this.bulkOp.set(op);
    }
  }

  closeBulk(): void {
    this.bulkOp.set(null);
  }

  async confirmBulk(): Promise<void> {
    const op = this.bulkOp();
    if (op && (await this.runBulk(op, this.bulkRole() || undefined))) this.bulkOp.set(null);
  }

  private async runBulk(op: BulkPeopleOperation, role?: string): Promise<boolean> {
    this.busy.set(true);
    const out = await this.people.bulk(op, role);
    this.busy.set(false);
    this.show({ level: out.ok ? 'success' : 'error', message: out.message });
    return out.ok || out.message !== t('ui.people.chooseRole');
  }

  // ------------------------------------------------------------ internals

  private resetAdd(): void {
    this.addEmail.set('');
    this.addName.set('');
    this.addRoles.set([]);
    this.addInvite.set(true);
    this.addErrors.set({});
  }

  private async loadPerson(id: string | undefined): Promise<void> {
    this.personError.set('');
    if (!id) {
      this.person.set(null);
      this.confirmingSuspend.set(false);
      this.highlight.set(null);
      return;
    }
    try {
      const p = await this.people.person(id);
      if (this.state().person !== id) return;
      this.person.set(p ?? null);
      this.roleDraft.set([...(p?.roles ?? [])]);
      if (!p) this.personError.set(t('ui.people.notFound'));
    } catch (e) {
      if (this.state().person === id) this.personError.set((e as { message?: string }).message ?? t('ui.common.loadFailed'));
    }
  }

  private async run(action: () => Promise<{ ok: boolean; message: string }>): Promise<boolean> {
    this.busy.set(true);
    const out = await action();
    this.busy.set(false);
    this.show({ level: out.ok ? 'success' : 'error', message: out.message });
    return out.ok;
  }

  private show(n: Notice): void {
    this.notice.set(n);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), n.level === 'error' ? 8000 : 4000);
  }
}
