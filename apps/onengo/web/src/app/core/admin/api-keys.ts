import { t } from '../i18n/i18n';
import { Snapshots, type AdminGateway, type ApiKey, type RoleSummary } from './admin';
import { writeFlag } from './address';
import { failure, type AdminResult, type Navigate } from './roles';

export interface ApiKeysSnapshot {
  keys: ApiKey[];
  roles: RoleSummary[];
  feeds: { key: string; label: string }[];
  loading: boolean;
  error: string;
  busy: boolean;
  /** The key just created, with its secret: shown once in the panel, never in the address, gone when closed. */
  created: { name: string; role: string | null; feed: string | null; token: string } | null;
  /** The key whose revoke is being confirmed in the panel. */
  revoking: ApiKey | null;
}

/**
 * API keys (`/admin/api-keys`, `?create`): list, create with the secret shown
 * once, and revoke confirmed in the panel. The secret lives only in this
 * snapshot; every address change goes through `navigate`, which never gets it.
 */
export class ApiKeysSession {
  readonly state = new Snapshots<ApiKeysSnapshot>({ keys: [], roles: [], feeds: [], loading: false, error: '', busy: false, created: null, revoking: null });

  constructor(
    private readonly gateway: AdminGateway,
    private readonly nav: Navigate,
  ) {}

  async load(): Promise<void> {
    this.state.set({ loading: true, error: '' });
    try {
      const [keys, roles, feeds] = await Promise.all([this.gateway.apiKeys(), this.gateway.roles(), this.gateway.dataFeeds()]);
      this.state.set({ keys, roles, feeds, loading: false });
    } catch (e) {
      this.state.set({ loading: false, error: failure(e) });
    }
  }

  roleLabel(key: string): string {
    return this.state.value.roles.find((r) => r.key === key)?.label ?? key;
  }

  openCreate(): void {
    this.nav.navigate(writeFlag('create', true), false);
  }

  closeCreate(): void {
    this.nav.navigate(writeFlag('create', false), true);
  }

  feedLabel(key: string): string {
    return this.state.value.feeds.find((f) => f.key === key)?.label ?? key;
  }

  async create(input: { name: string; role?: string; feed?: string }): Promise<AdminResult & { issues?: Record<string, string> }> {
    const issues: Record<string, string> = {};
    if (!input.name.trim()) issues['name'] = t('ui.records.required', { field: t('ui.admin.keys.col.name') });
    if (input.feed !== undefined) {
      if (!input.feed) issues['feed'] = t('ui.records.required', { field: t('ui.admin.keys.feed') });
    } else if (!input.role) {
      issues['role'] = t('ui.records.required', { field: t('ui.admin.keys.role') });
    }
    if (Object.keys(issues).length) return { ok: false, message: '', issues };
    this.state.set({ busy: true });
    try {
      const key = await this.gateway.createApiKey({ name: input.name.trim(), role: input.role || undefined, feed: input.feed || undefined });
      const { token, ...view } = key;
      this.state.set({ busy: false, created: { name: view.name, role: view.role, feed: view.feed, token }, keys: [view, ...this.state.value.keys] });
      this.nav.navigate(writeFlag('create', false), true);
      return { ok: true, message: '' };
    } catch (e) {
      this.state.set({ busy: false });
      return { ok: false, message: failure(e) };
    }
  }

  /** Closing the secret's panel forgets the secret for good. */
  dismissSecret(): void {
    this.state.set({ created: null });
  }

  askRevoke(id: string): void {
    this.state.set({ revoking: this.state.value.keys.find((k) => k.id === id && !k.revokedAt) ?? null });
  }

  cancelRevoke(): void {
    this.state.set({ revoking: null });
  }

  async confirmRevoke(): Promise<AdminResult> {
    const key = this.state.value.revoking;
    if (!key) return { ok: false, message: '' };
    this.state.set({ busy: true });
    try {
      await this.gateway.revokeApiKey(key.id);
      this.state.set({ busy: false, revoking: null });
      await this.load();
      return { ok: true, message: t('ui.admin.keys.revokedMsg', { name: key.name }) };
    } catch (e) {
      this.state.set({ busy: false });
      return { ok: false, message: failure(e) };
    }
  }
}
