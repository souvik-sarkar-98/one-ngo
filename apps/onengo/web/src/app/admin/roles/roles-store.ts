import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { readFlag } from '../../core/admin/address';
import { RoleMembersSession, RolesList, type RoleMembersSnapshot, type RolesSnapshot } from '../../core/admin/roles';
import { httpAccess } from '../../core/builder/http-access';
import { roleKey } from '../../core/builder/permission-grid';
import { t } from '../../core/i18n/i18n';
import { Api } from '../../services/api';
import type { Suggestion } from '../../core/ui-logic/autocomplete';
import { AdminBase } from '../admin-store';
import { memberColumns, memberRow, roleColumns, roleRow } from '../rows';

/** Administration › Roles: every role with its member count. */
@Injectable()
export class RolesStore extends AdminBase {
  private readonly list = new RolesList(this.gateway);
  private readonly access = httpAccess(inject(Api));
  readonly state = signal<RolesSnapshot>(this.list.state.value);
  readonly creating = signal(false);
  readonly createError = signal('');
  readonly busy = signal(false);
  readonly canCreate = computed(() => !!this.session.me()?.capabilities.roles);
  readonly columns = computed(() => {
    this.i18n.locale();
    return roleColumns();
  });
  readonly rows = computed(() => {
    this.i18n.locale();
    return this.state()
      .roles.filter((r) => this.matches(r.label, r.key))
      .map(roleRow);
  });

  constructor() {
    super();
    this.list.state.subscribe((s) => this.state.set(s));
    void this.list.load();
  }

  open(key: string): void {
    this.go(`/admin/roles/${encodeURIComponent(key)}`);
  }

  retry(): void {
    void this.list.load();
  }

  startNew(): void {
    this.createError.set('');
    this.creating.set(true);
  }

  cancelNew(): void {
    this.creating.set(false);
  }

  async create(name: string): Promise<void> {
    const key = roleKey(name);
    if (!key) {
      this.createError.set(t('ui.builder.catalogue.nameRequired'));
      return;
    }
    this.busy.set(true);
    this.createError.set('');
    try {
      await this.access.createRole({ key, label: name.trim(), permissions: [], requireTwoStep: false });
      this.creating.set(false);
      this.go(`/admin/roles/${encodeURIComponent(key)}?tab=permissions`);
    } catch (e) {
      const message = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : t('ui.common.somethingWentWrong');
      this.createError.set(message);
    } finally {
      this.busy.set(false);
    }
  }
}

/** A role's members with Remove and Add people (`/admin/roles/:key`, `?add`). */
@Injectable()
export class RoleStore extends AdminBase {
  readonly key = this.route.snapshot.paramMap.get('key') ?? '';
  readonly members = new RoleMembersSession(this.gateway, this.key, this.nav);
  readonly state = signal<RoleMembersSnapshot>(this.members.state.value);
  readonly adding = signal(false);
  readonly source = this.members.candidates();
  readonly label = computed(() => this.state().page?.role.label ?? this.key);
  readonly requiresTwoStep = signal(false);
  readonly tab = signal<'members' | 'permissions'>('members');
  /** Permissions are the role definition. Shown to people who configure the app or manage roles. */
  readonly canPermissions = computed(() => {
    const c = this.session.me()?.capabilities;
    return !!(c?.configure || c?.roles);
  });
  readonly columns = computed(() => {
    this.i18n.locale();
    return memberColumns();
  });
  readonly rows = computed(() => {
    this.i18n.locale();
    const page = this.state().page;
    return (page?.items ?? []).filter((p) => this.matches(p.displayName, p.email)).map((p) => memberRow(p, this.key, page!.roles));
  });

  constructor() {
    super();
    this.members.state.subscribe((s) => this.state.set(s));
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      this.adding.set(readFlag((n) => p.get(n), 'add'));
      this.tab.set(p.get('tab') === 'permissions' && this.canPermissions() ? 'permissions' : 'members');
    });
    void this.members.load();
    void this.gateway
      .roles()
      .then((roles) => this.requiresTwoStep.set(!!roles.find((r) => r.key === this.key)?.requireTwoStep))
      .catch(() => undefined);
    effect(() => {
      const label = this.label();
      untracked(() => this.meta.crumbLabels.set({ role: label }));
    });
  }

  retry(): void {
    void this.members.load();
  }

  showTab(tab: 'members' | 'permissions'): void {
    this.nav.navigate({ tab: tab === 'members' ? null : 'permissions' }, true);
  }

  openAdd(): void {
    this.members.openAdd();
  }

  closeAdd(): void {
    this.members.closeAdd();
  }

  pick(s: Suggestion): void {
    this.members.pick(s);
  }

  unpick(id: string): void {
    this.members.unpick(id);
  }

  async add(): Promise<void> {
    this.show(await this.members.add());
  }

  async rowAction(id: string, action: string): Promise<void> {
    if (action === 'remove') this.show(await this.members.remove(id));
  }

  openPerson(id: string): void {
    if (this.session.me()?.capabilities.people) this.go(`/admin/people?status=all&person=${encodeURIComponent(id)}`);
  }

  twoStepNote(): string {
    return t('ui.admin.roles.twoStepNote', { role: this.label() });
  }
}
