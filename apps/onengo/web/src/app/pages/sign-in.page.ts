import { Component, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';
import { signInRefusalKey } from '../core/auth/sign-in-notice';
import { t } from '../core/i18n/i18n';
import { PRODUCT, browserTitle, type SignInOrganisation } from '../core/organisation/organisation';
import { ANOTHER_ORGANISATION } from '../core/organisation/sign-in';
import { safeNext } from '@onengo/web-kit';
import { organisationLogo } from '../core/shell/shell';
import { applyTheme } from '../core/theme';
import { pointAppleTouchIcon } from '../pwa/install';
import { ApiError } from '../services/api';
import { TranslatePipe } from '../services/i18n';
import { Session } from '../services/session';
import { SignInStore } from './sign-in-store';

/**
 * The credential tabs and the one-off modes drawn in their place. `password`
 * and `code` are the two tabs; `forgot` (reset link), `ticket` (an
 * authenticator step) and `codeonly` (the generic organisation-code form) take
 * the whole card instead.
 */
type Mode = 'password' | 'code' | 'forgot' | 'ticket' | 'codeonly';

/**
 * Signing in. At `/o/<code>/sign-in` it is the organisation's own page: OneNGO
 * with the NGO's name and logo, its credential tabs, its sign-in provider and
 * no organisation code to type. At `/sign-in` it asks only for the
 * organisation code, then opens that organisation's own page.
 */
@Component({
  selector: 'app-sign-in',
  imports: [TranslatePipe],
  providers: [SignInStore],
  styles: `
    :host {
      display: grid;
      min-height: 100dvh;
      place-items: center;
      box-sizing: border-box;
      padding: 32px 16px;
      background:
        radial-gradient(ellipse 80% 48% at 50% -8%, color-mix(in srgb, var(--brand, #1f5f8b) 22%, transparent), transparent),
        var(--bg, #f5f7fa);
      color: var(--fg, #1c2430);
    }
    .auth {
      margin: 0;
    }
    .brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      text-align: center;
    }
    .brand__product {
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-size: 0.72rem;
      color: var(--brand, #1f5f8b);
    }
    .brand__logo {
      width: 88px;
      height: 88px;
      object-fit: contain;
      padding: 10px;
      box-sizing: border-box;
      border-radius: 24px;
      background: var(--card, #fff);
      border: 1px solid var(--line, #d8dee6);
      box-shadow: 0 10px 28px color-mix(in srgb, var(--fg, #1c2430) 8%, transparent);
    }
    .brand__org {
      margin: 4px 0 0;
      font-size: 1.55rem;
      font-weight: 700;
      line-height: 1.2;
    }
    .tabs {
      margin: -2px -2px 12px;
    }
    .tabs button {
      flex: 1;
      padding: 4px 6px 10px;
      font-weight: 600;
    }
    .sso {
      margin: 12px 0 0;
    }
    .sso .button {
      display: block;
      width: 100%;
    }
  `,
  template: `
    <div class="auth">
      <div class="brand">
        <span class="brand__product">{{ product }}</span>
        @if (org(); as o) {
          @if (logo()) {
            <img class="brand__logo" [src]="logo()" alt="" />
          }
          <p class="brand__org">{{ o.displayName }}</p>
        }
      </div>

      @if (orgState() === 'loading') {
        <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
      } @else if (orgState() === 'not-found') {
        <h1>{{ 'ui.auth.orgNotFound' | t }}</h1>
        <div class="card">
          <div class="acts">
            <button type="button" class="primary" (click)="useAnother()">{{ 'ui.auth.signInWithCode' | t }}</button>
          </div>
        </div>
      } @else if (mode() === 'codeonly') {
        <h1>{{ 'ui.auth.codeFormTitle' | t }}</h1>
        <form class="card" (submit)="submit($event)">
          @if (error()) { <div class="notice error" role="alert">{{ error() }}</div> }
          <div class="field">
            <label for="org">{{ 'ui.auth.organisationCode' | t }}</label>
            <input id="org" name="org" autocomplete="organization" spellcheck="false" [value]="tenant()" (input)="tenant.set(value($event))" required />
          </div>
          <div class="acts">
            <button class="primary" type="submit" [disabled]="busy()">{{ 'ui.auth.continue' | t }}</button>
          </div>
        </form>
        <p class="auth__hint muted">{{ 'ui.auth.codeFormHint' | t }}</p>
      } @else {
        <h1>{{ (mode() === 'forgot' ? 'ui.auth.resetTitle' : 'ui.auth.signIn') | t }}</h1>
        <form class="card" (submit)="submit($event)">
          @if (mode() === 'password' || mode() === 'code') {
            <div class="tabs" role="tablist">
              <button type="button" role="tab" [attr.aria-selected]="mode() === 'password'" [class.active]="mode() === 'password'" (click)="tab($event, 'password')">{{ 'ui.auth.tabPassword' | t }}</button>
              <button type="button" role="tab" [attr.aria-selected]="mode() === 'code'" [class.active]="mode() === 'code'" (click)="tab($event, 'code')">{{ 'ui.auth.tabCode' | t }}</button>
            </div>
          }

          @if (error()) { <div class="notice error" role="alert">{{ error() }}</div> }
          @if (info()) { <div class="notice info" role="status">{{ info() }}</div> }

          @if (mode() !== 'ticket') {
            <div class="field">
              <label for="email">{{ 'ui.auth.email' | t }}</label>
              <input id="email" name="email" type="email" autocomplete="username" [value]="email()" (input)="email.set(value($event))" required />
            </div>
          }
          @if (mode() === 'password') {
            <div class="field">
              <label for="password">{{ 'ui.auth.password' | t }}</label>
              <input id="password" name="password" type="password" autocomplete="current-password" (input)="password.set(value($event))" required />
            </div>
          } @else if (mode() === 'code' && codeSent()) {
            <div class="field">
              <label for="code">{{ 'ui.auth.emailCode' | t }}</label>
              <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" (input)="code.set(value($event))" required />
            </div>
          }
          @if (needTotp() || mode() === 'ticket') {
            <div class="field">
              <label for="totp">{{ 'ui.auth.totp' | t }}</label>
              <input id="totp" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" (input)="totp.set(value($event))" required />
            </div>
          }

          <div class="acts">
            <button class="primary" type="submit" [disabled]="busy()">{{ submitLabel() | t }}</button>
          </div>
          @if (mode() === 'password') {
            <p class="auth__more"><button type="button" class="link-button" (click)="switchMode($event, 'forgot')">{{ 'ui.auth.forgot' | t }}</button></p>
          } @else if (mode() === 'forgot') {
            <p class="auth__more"><button type="button" class="link-button" (click)="switchMode($event, 'password')">{{ 'ui.auth.backToPassword' | t }}</button></p>
          }
        </form>

        @if (passkeys() && (mode() === 'password' || mode() === 'code')) {
          <p class="sso"><button type="button" class="button" [disabled]="busy()" (click)="signInWithPasskey()">{{ 'ui.auth.passkeySignIn' | t }}</button></p>
        }

        @if (mode() !== 'ticket') {
          @for (p of providers(); track p.id) {
            <p class="sso"><a class="button" [href]="providerUrl(p.id)">{{ 'ui.auth.signInWith' | t: { provider: p.label } }}</a></p>
          }
        }
        @if (org()) {
          <p class="auth__more switchorg"><button type="button" class="link-button" (click)="useAnother()">{{ 'ui.auth.useAnother' | t }}</button></p>
        }
      }
    </div>
  `,
})
export class SignInPage {
  private readonly session = inject(Session);
  private readonly store = inject(SignInStore);
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);

  readonly product = PRODUCT;
  /** Set once the organisation is known to offer passkeys and this browser can use them. */
  readonly passkeys = signal(false);
  readonly mode = signal<Mode>('password');
  readonly tenant = signal(this.session.lastOrganisation);
  readonly email = signal('');
  readonly password = signal('');
  readonly code = signal('');
  readonly totp = signal('');
  readonly codeSent = signal(false);
  readonly needTotp = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  readonly providers = signal<{ id: string; label: string }[]>([]);
  /** The organisation of an `/o/<code>/sign-in` page once found. */
  readonly org = signal<SignInOrganisation | null>(null);
  readonly orgState = signal<'none' | 'loading' | 'ready' | 'not-found'>('none');
  readonly logo = signal<string | null>(null);
  private ticket = '';
  /** The document theme colour before an organisation theme replaces it. */
  private themeColor: string | null = null;

  constructor() {
    const q = this.route.snapshot.queryParamMap;
    const refusal = signInRefusalKey(q.get('reason'));
    if (refusal) this.error.set(t(refusal));
    const ticket = q.get('ticket');
    if (ticket) {
      this.ticket = ticket;
      this.mode.set('ticket');
      this.info.set(t('ui.auth.ticketInfo'));
    }
    if (q.has('reason') || q.has('message') || ticket) history.replaceState(null, '', location.pathname);
    const code = this.route.snapshot.paramMap.get('code');
    this.title.setTitle(browserTitle(t('ui.auth.signIn')));
    if (code === null) {
      // The generic /sign-in only collects the organisation code; credentials
      // are entered on that organisation's own page. A two-step ticket is the
      // one exception that stays here. It keeps the default colours.
      this.paintTheme(null);
      if (!ticket) this.mode.set('codeonly');
      if (q.has(ANOTHER_ORGANISATION)) this.tenant.set('');
    } else void this.loadOrganisation(code);
  }

  value(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  /** The key of the submit button's text. */
  submitLabel(): string {
    switch (this.mode()) {
      case 'forgot':
        return 'ui.auth.sendReset';
      case 'code':
        return this.codeSent() ? 'ui.auth.signIn' : 'ui.auth.sendCode';
      default:
        return 'ui.auth.signIn';
    }
  }

  providerUrl(id: string): string {
    return this.session.providerUrl(id, this.orgCode(), safeNext(this.next()));
  }

  async loadOrganisation(code: string): Promise<void> {
    this.orgState.set('loading');
    try {
      const found = await this.store.organisationFor(code);
      if (found === 'not-found') {
        pointAppleTouchIcon(null);
        this.paintTheme(null);
        this.orgState.set('not-found');
        this.title.setTitle(browserTitle(t('ui.auth.signIn')));
        return;
      }
      this.org.set(found);
      this.tenant.set(found.code);
      this.providers.set(found.providers);
      const logo = organisationLogo(found.logoUrl);
      this.logo.set(logo);
      pointAppleTouchIcon(logo ? `/api/auth/organisations/${found.code}/icon/180` : null);
      this.paintTheme(found);
      this.title.setTitle(browserTitle(found.displayName));
      this.orgState.set('ready');
      void this.session.passkeysOffered(found.code).then((offered) => this.passkeys.set(offered));
    } catch (err) {
      this.paintTheme(null);
      this.orgState.set('none');
      this.error.set(err instanceof ApiError ? err.message : t('ui.auth.failed'));
    }
  }

  /**
   * Paints the published organisation colours. The signed-in shell applies its
   * own theme as it opens, so this page does not clear the colours when it
   * leaves — that would wipe the shell's theme.
   */
  private paintTheme(org: SignInOrganisation | null): void {
    const theme = org?.theme ?? null;
    applyTheme(theme ? { key: 'organisation', ...theme } : null);
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    if (this.themeColor === null) this.themeColor = meta.getAttribute('content') ?? '';
    meta.setAttribute('content', theme?.brand?.trim() || this.themeColor);
  }

  useAnother(): void {
    void this.store.useAnother(this.next());
  }

  /** Switch between the Password and Email code tabs, keeping the typed email. */
  tab(e: Event, mode: 'password' | 'code'): void {
    e.preventDefault();
    if (this.mode() === mode) return;
    this.mode.set(mode);
    this.codeSent.set(false);
    this.error.set('');
    this.info.set('');
  }

  switchMode(e: Event, mode: Mode): void {
    e.preventDefault();
    this.mode.set(mode);
    this.codeSent.set(false);
    this.error.set('');
    this.info.set('');
  }

  async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (this.mode() === 'codeonly') {
      void this.store.openOrganisation(this.tenant(), this.next());
      return;
    }
    this.busy.set(true);
    this.error.set('');
    const tenant = this.orgCode();
    const totpCode = this.needTotp() ? this.totp().trim() : undefined;
    try {
      switch (this.mode()) {
        case 'forgot':
          await this.session.requestPasswordReset(tenant, this.email());
          this.info.set(t('ui.auth.resetSent'));
          return;
        case 'code':
          if (!this.codeSent()) {
            await this.session.requestCode(tenant, this.email());
            this.codeSent.set(true);
            this.info.set(t('ui.auth.codeSent'));
            return;
          }
          await this.session.signInWithCode({ tenant, email: this.email(), code: this.code().trim(), totpCode });
          break;
        case 'ticket':
          await this.session.completeTwoStepTicket(this.ticket, this.totp().trim());
          break;
        default:
          await this.session.signInWithPassword({ tenant, email: this.email(), password: this.password(), totpCode });
      }
      await this.store.continue(this.next());
    } catch (err) {
      const message = err instanceof ApiError ? err.message : t('ui.auth.failed');
      if (/authenticator app/i.test(message) && this.mode() !== 'ticket') {
        this.needTotp.set(true);
        this.info.set(message);
      } else this.error.set(message);
    } finally {
      this.busy.set(false);
    }
  }

  /** Signs in with a passkey saved on this device; a cancelled prompt leaves the card as it was. */
  async signInWithPasskey(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.info.set('');
    try {
      const ticket = await this.session.signInWithPasskey(this.orgCode());
      if (ticket) {
        this.ticket = ticket;
        this.mode.set('ticket');
        this.info.set(t('ui.auth.ticketInfo'));
        return;
      }
      await this.store.continue(this.next());
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return;
      this.error.set(err instanceof ApiError ? err.message : t('ui.auth.passkeyFailed'));
    } finally {
      this.busy.set(false);
    }
  }

  private next(): string | null {
    return this.route.snapshot.queryParamMap.get('next');
  }

  private orgCode(): string {
    return this.org()?.code ?? this.tenant().trim().toLowerCase();
  }
}
