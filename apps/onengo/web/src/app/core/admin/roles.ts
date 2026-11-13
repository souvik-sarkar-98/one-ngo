import type { Params } from '../address';
import { t } from '../i18n/i18n';
import type { PersonItem } from '../people/people';
import { asGatewayError } from '../records/gateway/gateway';
import type { Suggestion, SuggestionSource } from '../ui-logic/autocomplete';
import { Snapshots, type AdminGateway, type RoleMembersPage, type RoleSummary } from './admin';
import { writeFlag } from './address';

export interface Navigate {
  /** Writes parameters to the address bar; `replace` keeps the current history entry. */
  navigate(params: Params, replace: boolean): void;
}

export interface AdminResult {
  ok: boolean;
  message: string;
}

export const failure = (e: unknown) => asGatewayError(e, t('ui.common.somethingWentWrong')).message;

export interface RolesSnapshot {
  roles: RoleSummary[];
  loading: boolean;
  error: string;
}

/** Administration › Roles: every role with how many people have it. Membership only; what a role allows is in the Builder. */
export class RolesList {
  readonly state = new Snapshots<RolesSnapshot>({ roles: [], loading: false, error: '' });
  constructor(private readonly gateway: AdminGateway) {}

  async load(): Promise<void> {
    this.state.set({ loading: true, error: '' });
    try {
      const roles = await this.gateway.roles();
      this.state.set({ roles: [...roles].sort((a, b) => a.label.localeCompare(b.label)), loading: false });
    } catch (e) {
      this.state.set({ loading: false, error: failure(e) });
    }
  }
}

export interface RoleMembersSnapshot {
  page: RoleMembersPage | null;
  loading: boolean;
  error: string;
  /** People chosen in Add people, not yet added. */
  picked: Suggestion[];
  busy: boolean;
}

/**
 * A role's members (`/admin/roles/:key`, `?add`): Remove takes the role away
 * at once; Add people gives it to several active or invited people. The server
 * refuses removing the last person who can manage roles, and its message is shown.
 */
export class RoleMembersSession {
  readonly state = new Snapshots<RoleMembersSnapshot>({ page: null, loading: false, error: '', picked: [], busy: false });

  constructor(
    private readonly gateway: AdminGateway,
    readonly role: string,
    private readonly nav: Navigate,
  ) {}

  async load(): Promise<void> {
    this.state.set({ loading: true, error: '' });
    try {
      this.state.set({ page: await this.gateway.roleMembers(this.role), loading: false });
    } catch (e) {
      this.state.set({ loading: false, error: failure(e) });
    }
  }

  get label(): string {
    return this.state.value.page?.role.label ?? this.role;
  }

  openAdd(): void {
    this.state.set({ picked: [] });
    this.nav.navigate(writeFlag('add', true), false);
  }

  closeAdd(): void {
    this.nav.navigate(writeFlag('add', false), true);
  }

  /** Active and invited people who do not have the role yet, named with their email and roles. */
  candidates(): SuggestionSource {
    return {
      minLength: 1,
      search: async (text) => {
        const have = new Set([...(this.state.value.page?.items ?? []).map((p) => p.userId), ...this.state.value.picked.map((p) => p.id)]);
        const people = await this.gateway.candidates(text.trim());
        return people.filter((p) => !have.has(p.userId)).map((p: PersonItem) => ({ id: p.userId, label: p.displayName, hint: p.email }));
      },
    };
  }

  pick(s: Suggestion): void {
    if (!this.state.value.picked.some((p) => p.id === s.id)) this.state.set({ picked: [...this.state.value.picked, s] });
  }

  unpick(id: string): void {
    this.state.set({ picked: this.state.value.picked.filter((p) => p.id !== id) });
  }

  async add(): Promise<AdminResult> {
    const picked = this.state.value.picked;
    if (!picked.length) return { ok: false, message: t('ui.common.noItems') };
    this.state.set({ busy: true });
    try {
      await this.gateway.addRoleMembers(this.role, picked.map((p) => p.id));
      this.state.set({ busy: false, picked: [] });
      this.closeAdd();
      await this.load();
      return { ok: true, message: t('ui.admin.roles.added', { count: picked.length, role: this.label }) };
    } catch (e) {
      this.state.set({ busy: false });
      return { ok: false, message: failure(e) };
    }
  }

  async remove(userId: string): Promise<AdminResult> {
    const person = this.state.value.page?.items.find((p) => p.userId === userId);
    this.state.set({ busy: true });
    try {
      await this.gateway.removeRoleMember(this.role, userId);
      this.state.set({ busy: false });
      await this.load();
      return { ok: true, message: t('ui.admin.roles.removed', { name: person?.displayName ?? userId, role: this.label }) };
    } catch (e) {
      this.state.set({ busy: false });
      return { ok: false, message: failure(e) };
    }
  }
}
