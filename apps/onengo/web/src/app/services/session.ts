import { Injectable, inject, signal } from '@angular/core';
import { httpAuth, providerStartUrl } from '../core/auth/http-auth';
import { getPasskey, passkeysSupported } from '../core/auth/passkey';
import type { Me, RuntimeAction, RuntimeDefinitions, RuntimeRecordType, RuntimeWorkflow } from '../core/models';
import type { TokenResponse } from '../core/contracts';
import { Api } from './api';
import { I18n } from './i18n';

const LAST_ORG = 'ngo.lastOrganisation';

@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  private readonly auth = httpAuth(this.api);
  private readonly i18n = inject(I18n);
  readonly me = signal<Me | null>(null);
  readonly defs = signal<RuntimeDefinitions | null>(null);
  private loading: Promise<boolean> | null = null;

  /** Resolves true when signed in, restoring the session from the refresh cookie after a reload. */
  ensure(): Promise<boolean> {
    if (this.me()) return Promise.resolve(true);
    this.loading ??= (async () => {
      if (!this.api.hasToken && !(await this.api.refresh())) return false;
      await this.reload();
      return true;
    })()
      .catch(() => false)
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async reload(): Promise<void> {
    const [me, defs, text] = await Promise.all([this.auth.me(), this.auth.definitions(), this.auth.messages().catch(() => null)]);
    if (text) void this.i18n.use(text.locale, text.messages);
    this.me.set(me);
    this.defs.set(defs);
  }

  /** Saves the person's language and applies it at once: screen text and definition labels. */
  async changeLanguage(locale: string): Promise<void> {
    await this.auth.setLocale(locale);
    await this.reload();
  }

  get lastOrganisation(): string {
    return localStorage.getItem(LAST_ORG) ?? '';
  }

  /** "Use another organisation": the generic sign-in stops opening the last one. */
  forgetOrganisation(): void {
    localStorage.removeItem(LAST_ORG);
  }

  async signInWithPassword(input: { tenant: string; email: string; password: string; totpCode?: string }): Promise<void> {
    const res = await this.auth.login(input);
    await this.afterSignIn(input.tenant, res.accessToken);
  }

  requestCode(tenant: string, email: string): Promise<void> {
    return this.auth.requestCode(tenant, email);
  }

  async signInWithCode(input: { tenant: string; email: string; code: string; totpCode?: string }): Promise<void> {
    const res = await this.auth.verifyCode(input);
    await this.afterSignIn(input.tenant, res.accessToken);
  }

  /** Whether this organisation offers passkeys and this browser can use them. Never throws. */
  async passkeysOffered(tenant: string): Promise<boolean> {
    try {
      const [{ enabled }, supported] = await Promise.all([
        this.api.get<{ enabled: boolean }>(`/api/auth/passkey/available?tenant=${encodeURIComponent(tenant)}`),
        passkeysSupported(),
      ]);
      return enabled && supported;
    } catch {
      return false;
    }
  }

  /**
   * Signs in with a passkey on this device. Resolves with a two-step ticket when the
   * person also has an authenticator app, otherwise signs them in and resolves null.
   */
  async signInWithPasskey(tenant: string): Promise<string | null> {
    const { challengeId, options } = await this.api.post<{ challengeId: string; options: unknown }>('/api/auth/passkey/options', { tenant });
    const response = await getPasskey(options);
    const out = await this.api.post<TokenResponse | { ticket: string }>('/api/auth/passkey/sign-in', { tenant, challengeId, response });
    if ('ticket' in out) return out.ticket;
    await this.afterSignIn(tenant, out.accessToken);
    return null;
  }

  async completeTwoStepTicket(ticket: string, totpCode: string): Promise<void> {
    const res = await this.auth.completeTwoStep(ticket, totpCode);
    this.api.setToken(res.accessToken);
    await this.reload();
  }

  async signOut(): Promise<void> {
    await this.auth.logout().catch(() => undefined);
    this.api.setToken(null);
    this.me.set(null);
    this.defs.set(null);
  }

  providers(tenant: string): Promise<{ id: string; label: string }[]> {
    return this.auth.providers(tenant);
  }

  providerUrl(id: string, tenant: string, next: string): string {
    return providerStartUrl(id, tenant, next);
  }

  requestPasswordReset(tenant: string, email: string): Promise<void> {
    return this.auth.requestPasswordReset(tenant, email);
  }

  passwordTokenUsable(token: string): Promise<boolean> {
    return this.auth.passwordTokenUsable(token);
  }

  completePasswordReset(token: string, password: string): Promise<void> {
    return this.auth.completePasswordReset(token, password);
  }

  recordType(key: string): RuntimeRecordType | undefined {
    return this.defs()?.recordTypes.find((t) => t.key === key);
  }

  workflow(recordType: string): RuntimeWorkflow | undefined {
    return this.defs()?.workflows[recordType];
  }

  /** Every workflow of the record type, primary first. */
  workflows(recordType: string): RuntimeWorkflow[] {
    return this.defs()?.workflowSets?.[recordType] ?? [];
  }

  actions(recordType: string): RuntimeAction[] {
    return this.defs()?.actions?.[recordType] ?? [];
  }

  private async afterSignIn(tenant: string, token: string): Promise<void> {
    localStorage.setItem(LAST_ORG, tenant);
    this.api.setToken(token);
    await this.reload();
  }
}
