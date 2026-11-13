import { Component, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { PASSWORD_MIN_LENGTH, newPasswordProblem } from '../core/auth/password-rules';
import { t } from '../core/i18n/i18n';
import { browserTitle } from '../core/organisation/organisation';
import { afterPasswordSet } from '../core/organisation/sign-in';
import { ApiError } from '../services/api';
import { TranslatePipe } from '../services/i18n';
import { Session } from '../services/session';

@Component({
  selector: 'app-reset-password',
  imports: [RouterLink, TranslatePipe],
  template: `
    <div class="auth">
      <h1>{{ (invite ? 'ui.reset.inviteTitle' : 'ui.reset.title') | t }}</h1>
      <div class="card">
        @if (done()) {
          <div class="notice ok" role="status">{{ 'ui.reset.done' | t }}</div>
          <a class="button primary" [routerLink]="signIn">{{ 'ui.reset.goToSignIn' | t }}</a>
        } @else if (!token) {
          <div class="notice error">{{ 'ui.reset.incomplete' | t }}</div>
        } @else if (expired()) {
          <div class="notice error">{{ 'ui.reset.expired' | t }}</div>
        } @else if (checking()) {
          <div class="notice" role="status">{{ 'ui.common.loading' | t }}</div>
        } @else {
          <form (submit)="submit($event)" novalidate>
            @if (error()) { <div class="notice error" role="alert">{{ error() }}</div> }
            <div class="field">
              <label for="pw">{{ 'ui.reset.newPassword' | t }}</label>
              <input id="pw" type="password" autocomplete="new-password" [attr.minlength]="minLength" (input)="password.set(value($event))" required />
              <div class="help">{{ 'ui.reset.help' | t }}</div>
            </div>
            <div class="field">
              <label for="pw2">{{ 'ui.reset.again' | t }}</label>
              <input id="pw2" type="password" autocomplete="new-password" (input)="confirm.set(value($event))" required />
            </div>
            <button class="primary" type="submit" [disabled]="busy()">{{ 'ui.reset.save' | t }}</button>
          </form>
        }
      </div>
    </div>
  `,
})
export class ResetPasswordPage {
  private readonly session = inject(Session);
  readonly token: string;
  readonly invite: boolean;
  /** The organisation's own sign-in page when the link named it. */
  readonly signIn: string;
  readonly password = signal('');
  readonly confirm = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly done = signal(false);
  readonly checking = signal(false);
  readonly expired = signal(false);
  readonly minLength = PASSWORD_MIN_LENGTH;

  constructor() {
    const q = inject(ActivatedRoute).snapshot.queryParamMap;
    this.token = q.get('token') ?? '';
    this.invite = q.get('kind') === 'invite';
    const org = q.get('org');
    if (org) localStorage.setItem('ngo.lastOrganisation', org);
    this.signIn = afterPasswordSet(org);
    inject(Title).setTitle(browserTitle(t(this.invite ? 'ui.reset.inviteTitle' : 'ui.reset.title')));
    // Keep the one-time token out of browser history and any later page addresses.
    history.replaceState(null, '', '/reset-password');
    if (this.token) void this.check();
  }

  value(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  /** An expired or used link is said so here, rather than after a password has been typed and sent. */
  private async check(): Promise<void> {
    this.checking.set(true);
    try {
      this.expired.set(!(await this.session.passwordTokenUsable(this.token)));
    } catch {
      // The form stays: submitting says what went wrong.
    } finally {
      this.checking.set(false);
    }
  }

  async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.error.set('');
    const problem = newPasswordProblem(this.password(), this.confirm());
    if (problem) {
      this.error.set(t(problem));
      return;
    }
    this.busy.set(true);
    try {
      await this.session.completePasswordReset(this.token, this.password());
      this.done.set(true);
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : t('ui.reset.failed'));
    } finally {
      this.busy.set(false);
    }
  }
}
