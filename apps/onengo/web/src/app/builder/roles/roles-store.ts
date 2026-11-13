import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { httpAccess, type PermissionCatalogue, type RoleView } from '../../core/builder/http-access';
import { permissionGrid, roleKey, togglePermission } from '../../core/builder/permission-grid';
import { t } from '../../core/i18n/i18n';
import type { RowView } from '../../core/rows';
import { Api } from '../../services/api';
import { ScreenMeta } from '../../services/screen-meta';
import { Session } from '../../services/session';
import { Viewport } from '../../ui/viewport';

interface RoleDraft {
  label: string;
  requireTwoStep: boolean;
  permissions: string[];
}

function messageOf(e: unknown, fallback: string): string {
  return e && typeof e === 'object' && 'message' in e && 'code' in e ? String((e as { message: unknown }).message) : fallback;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Roles as definitions: their names, two-step requirement and permissions.
 * Who has a role is Administration's; the member count only links there.
 * The only place the roles screens reach the router and the server.
 */
@Injectable()
export class RolesStore {
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private readonly meta = inject(ScreenMeta);
  private readonly gateway = httpAccess(inject(Api));

  readonly narrow = inject(Viewport).narrow;
  readonly roles = signal<RoleView[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  readonly catalogue = signal<PermissionCatalogue | null>(null);
  readonly role = signal<RoleView | null>(null);
  readonly draft = signal<RoleDraft | null>(null);
  readonly creating = signal(false);
  readonly createError = signal('');

  readonly canManage = computed(() => !!this.session.me()?.capabilities.roles);
  /** Phones and people who may not manage roles see the roles read-only. */
  readonly canEdit = computed(() => this.canManage() && !this.narrow());
  readonly dirty = computed(() => {
    const r = this.role();
    const d = this.draft();
    return !!r && !!d && !same({ label: r.label, requireTwoStep: r.requireTwoStep, permissions: r.permissions }, d);
  });
  readonly grid = computed(() => {
    const c = this.catalogue();
    const d = this.draft();
    return c && d ? permissionGrid(c, d.permissions) : null;
  });
  readonly rows = computed<RowView[]>(() =>
    this.roles().map((r) => {
      const members = t('ui.builder.roles.members', { count: r.members });
      const twoStep = r.requireTwoStep ? t('ui.builder.roles.twoStepRequired') : '';
      const from = r.customised ? t('ui.builder.roles.changed') : t('ui.builder.roles.unchanged');
      return {
        id: r.key,
        title: r.label,
        subtitle: [r.key, twoStep].filter(Boolean).join(' · '),
        meta: members,
        cells: [
          { key: 'label', label: t('ui.builder.name'), value: r.label },
          { key: 'key', label: t('ui.builder.key'), value: r.key },
          { key: 'members', label: t('ui.builder.roles.membersColumn'), value: members },
          { key: 'twoStep', label: t('ui.builder.roles.twoStep'), value: twoStep || '—' },
          { key: 'from', label: t('ui.builder.catalogue.from'), value: from },
        ],
        actions: [
          { id: 'open', label: t('ui.builder.catalogue.open') },
          { id: 'members', label: t('ui.builder.roles.openMembers') },
          { id: 'view', label: t('ui.builder.roles.whatCanSee', { role: r.label }) },
          ...(this.canEdit() && !r.members ? [{ id: 'delete', label: t('ui.builder.roles.delete'), divider: true, tone: 'danger' as const }] : []),
        ],
      };
    }),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.meta.clear());
  }

  async loadList(): Promise<void> {
    this.meta.clear();
    await this.run(async () => this.roles.set(await this.gateway.roles()), t('ui.builder.roles.loadFailed'));
  }

  async loadRole(key: string): Promise<void> {
    this.role.set(null);
    this.draft.set(null);
    this.message.set('');
    await this.run(async () => {
      const [role, catalogue] = await Promise.all([this.gateway.role(key), this.gateway.permissionCatalogue()]);
      this.catalogue.set(catalogue);
      this.show(role);
    }, t('ui.builder.roles.loadFailed'));
  }

  setLabel(label: string): void {
    this.patch({ label });
  }

  setTwoStep(requireTwoStep: boolean): void {
    this.patch({ requireTwoStep });
  }

  toggle(permission: string, on: boolean): void {
    const d = this.draft();
    if (d) this.patch({ permissions: togglePermission(d.permissions, permission, on) });
  }

  async save(): Promise<void> {
    const r = this.role();
    const d = this.draft();
    if (!r || !d) return;
    this.busy.set(true);
    this.error.set('');
    try {
      this.show(await this.gateway.saveRole(r.key, d));
      this.message.set(t('ui.builder.roles.saved'));
      await this.session.reload();
    } catch (e) {
      this.error.set(messageOf(e, t('ui.builder.saveFailed')));
    } finally {
      this.busy.set(false);
    }
  }

  revert(): void {
    const r = this.role();
    if (r) this.show(r);
  }

  startNew(): void {
    this.createError.set('');
    this.creating.set(true);
  }

  async create(name: string): Promise<void> {
    const key = roleKey(name);
    if (!key) return this.createError.set(t('ui.builder.catalogue.nameRequired'));
    this.busy.set(true);
    this.createError.set('');
    try {
      await this.gateway.createRole({ key, label: name.trim(), permissions: [], requireTwoStep: false });
      this.creating.set(false);
      await this.router.navigate(['/admin/roles', key], { queryParams: { tab: 'permissions' } });
    } catch (e) {
      this.createError.set(messageOf(e, t('ui.common.somethingWentWrong')));
    } finally {
      this.busy.set(false);
    }
  }

  async runRowAction(key: string, action: string): Promise<void> {
    if (action === 'open') return this.openRole(key);
    if (action === 'members') return this.openMembers(key);
    if (action === 'view') return this.openRoleView(key);
    if (action !== 'delete') return;
    await this.run(async () => {
      await this.gateway.deleteRole(key);
      this.roles.set(await this.gateway.roles());
      this.message.set(t('ui.builder.roles.deleted'));
    }, t('ui.common.somethingWentWrong'));
  }

  openRole(key: string): void {
    void this.router.navigate(['/admin/roles', key], { queryParams: { tab: 'permissions' } });
  }

  /** Administration › Roles in the app, where people are given the role. */
  openMembers(key: string): void {
    void this.router.navigateByUrl(`/admin/roles/${encodeURIComponent(key)}`);
  }

  openRoleView(key: string): void {
    void this.router.navigate(['/builder/access'], { queryParams: { role: key } });
  }

  backToList(): void {
    void this.router.navigate(['/admin/roles']);
  }

  private show(role: RoleView): void {
    this.role.set(role);
    this.draft.set({ label: role.label, requireTwoStep: role.requireTwoStep, permissions: [...role.permissions] });
    this.meta.crumbLabels.set({ definition: role.label });
  }

  private patch(change: Partial<RoleDraft>): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, ...change });
    this.message.set('');
  }

  private async run(action: () => Promise<void>, fallback: string): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      await action();
    } catch (e) {
      this.error.set(messageOf(e, fallback));
    } finally {
      this.loading.set(false);
    }
  }
}
