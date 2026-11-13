import { Injectable, computed, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { readFlag } from '../../core/admin/address';
import { ApiKeysSession, type ApiKeysSnapshot } from '../../core/admin/api-keys';
import { API_DOCUMENTATION } from '../../core/admin/http-admin';
import { t } from '../../core/i18n/i18n';
import type { FormValues } from '../../core/records/record/forms';
import type { CfFieldDef } from '../../ui/cf-types';
import { AdminBase } from '../admin-store';
import { apiKeyColumns, apiKeyRow } from '../rows';

/**
 * API keys (`/admin/api-keys`, `?create`). The new key's secret is held only
 * by the session's snapshot and drawn in the panel; it is never put in the
 * address, history or a log, and closing the panel forgets it.
 */
@Injectable()
export class ApiKeysStore extends AdminBase {
  readonly keys = new ApiKeysSession(this.gateway, this.nav);
  readonly state = signal<ApiKeysSnapshot>(this.keys.state.value);
  readonly creating = signal(false);
  readonly values = signal<FormValues>({ name: '', subject: 'role', role: '', feed: '' });
  readonly errors = signal<Record<string, string>>({});
  readonly copied = signal(false);
  readonly documentation = API_DOCUMENTATION;
  readonly columns = computed(() => {
    this.i18n.locale();
    return apiKeyColumns();
  });
  readonly rows = computed(() => {
    this.i18n.locale();
    const now = new Date();
    return this.state().keys.map((k) => apiKeyRow(k, k.feed ? this.keys.feedLabel(k.feed) : this.keys.roleLabel(k.role ?? ''), now));
  });
  readonly fields = computed<CfFieldDef[]>(() => {
    this.i18n.locale();
    const subject = String(this.values()['subject'] ?? 'role');
    const name: CfFieldDef = { key: 'name', label: t('ui.admin.keys.col.name'), type: 'text', required: true, readOnly: false, options: [], hint: t('ui.admin.keys.nameHint') };
    const choice: CfFieldDef = {
      key: 'subject',
      label: t('ui.admin.keys.subject'),
      type: 'select',
      required: true,
      readOnly: false,
      options: [
        { key: 'role', label: t('ui.admin.keys.subjectRole') },
        { key: 'feed', label: t('ui.admin.keys.subjectFeed') },
      ],
    };
    if (subject === 'feed') {
      return [
        name,
        choice,
        {
          key: 'feed',
          label: t('ui.admin.keys.feed'),
          type: 'select',
          required: true,
          readOnly: false,
          options: this.state().feeds.map((f) => ({ key: f.key, label: f.label })),
          hint: t('ui.admin.keys.feedHint'),
        },
      ];
    }
    return [
      name,
      choice,
      {
        key: 'role',
        label: t('ui.admin.keys.role'),
        type: 'select',
        required: true,
        readOnly: false,
        options: this.state().roles.map((r) => ({ key: r.key, label: r.label })),
        hint: t('ui.admin.keys.roleHint'),
      },
    ];
  });

  constructor() {
    super();
    this.keys.state.subscribe((s) => this.state.set(s));
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((p) => {
      const open = readFlag((n) => p.get(n), 'create');
      if (open && !this.creating()) {
        this.values.set({ name: '', subject: 'role', role: '', feed: '' });
        this.errors.set({});
      }
      this.creating.set(open);
    });
    void this.keys.load();
  }

  readonly organisationCode = computed(() => this.session.me()?.tenant.key ?? '');

  async create(): Promise<void> {
    const v = this.values();
    const feed = String(v['subject'] ?? 'role') === 'feed';
    const out = await this.keys.create({
      name: String(v['name'] ?? ''),
      ...(feed ? { feed: String(v['feed'] ?? '') } : { role: String(v['role'] ?? '') }),
    });
    this.errors.set(out.issues ?? {});
    this.copied.set(false);
    if (!out.ok && out.message) this.show(out);
  }

  async copy(): Promise<void> {
    const token = this.state().created?.token;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      this.copied.set(true);
    } catch {
      this.copied.set(false);
    }
  }

  async rowAction(id: string, action: string): Promise<void> {
    if (action === 'revoke') this.keys.askRevoke(id);
  }

  async confirmRevoke(): Promise<void> {
    this.show(await this.keys.confirmRevoke());
  }
}
