import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { OperatorApi } from '../services/operator-api';

const REFUSED: Record<string, string> = {
  unknown: 'This login is not an operator on this console. Copy the provider and subject below for the person who manages operators.',
  mfa: 'The identity provider did not complete a fresh two-factor check.',
  provider: 'The identity provider did not complete sign-in. Try again in a moment.',
  ended: 'Your session has ended. Sign in again.',
};

@Component({
  standalone: true,
  template: `<section class="card"><h1>Sign in</h1>
    <p>Two-factor authentication is required. The account must already be an operator on this console.</p>
    @if (notice(); as text) { <p class="note bad">{{ text }}</p> }
    @if (issuer || subject) {
      <div class="kv">
        <div><b>Provider</b><code>{{ issuer }}</code></div>
        <div><b>Subject</b><code>{{ subject }}</code></div>
      </div>
    }
    <button type="button" (click)="signIn()">Continue</button>
  </section>`,
})
export class SignInPage {
  private readonly api = inject(OperatorApi);
  private readonly route = inject(ActivatedRoute);
  readonly issuer = this.route.snapshot.queryParamMap.get('issuer') ?? '';
  readonly subject = this.route.snapshot.queryParamMap.get('subject') ?? '';
  notice(): string { return REFUSED[this.route.snapshot.queryParamMap.get('refused') ?? ''] ?? ''; }
  signIn(): void { this.api.signIn(this.route.snapshot.queryParamMap.get('next') ?? '/organisations'); }
}

@Component({ standalone: true, template: `<section class="card"><h1>Completing sign-in</h1><p>The console is checking the identity provider response.</p></section>` })
export class CallbackPage {}

@Component({ standalone: true, template: `<section class="card"><h1>Additional verification</h1><p>Go back to the action and complete a fresh two-factor check. It can be used once, within five minutes.</p></section>` })
export class StepUpPage {}
