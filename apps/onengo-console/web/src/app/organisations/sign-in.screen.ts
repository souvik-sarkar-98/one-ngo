import { NgTemplateOutlet } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  OperatorAssuranceContract, OperatorProviderCheckContract, OperatorProviderOptInContract, OperatorSignInContract,
} from '@onengo/platform/contracts';
import { FormProblems } from '@onengo/web-kit';
import { OperatorApi } from '../services/operator-api';

interface ProviderForm {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  domains: string;
  /** Editing a provider that already has a stored secret. */
  existing: boolean;
}

interface OptInForm {
  enabled: boolean;
  assurance: OperatorAssuranceContract;
  domains: string;
}

const emptyProvider = (): ProviderForm => ({ id: '', label: '', issuer: 'https://', clientId: '', clientSecret: '', domains: '', existing: false });
const domainList = (text: string): string[] => text.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
const optInForm = (optIn: OperatorProviderOptInContract | null): OptInForm => ({
  enabled: optIn?.enabled ?? false,
  assurance: optIn?.assurance ?? 'aal1',
  domains: (optIn?.allowedDomains ?? []).join(', '),
});

/**
 * One organisation's sign-in. Every change needs a fresh MFA step-up for this organisation, which allows one
 * change within five minutes, and a reason kept in the audit. The operator verifies first and then makes the
 * change, so a client secret is never kept in the browser while it is away at the identity provider.
 */
@Component({
  standalone: true, imports: [FormsModule, FormProblems, NgTemplateOutlet, RouterLink],
  template: `<h1>Sign-in for {{view()?.organisation?.displayName ?? code()}}</h1>
    <p class="muted"><a routerLink="/organisations/status" [queryParams]="{ code: code() }">Back to status</a>
      · Code {{code()}} @if (view(); as v) { · {{v.organisation.status}} }</p>
    <app-form-problems [message]="error()" />
    @if (notice()) { <p class="notice">{{notice()}}</p> }
    @if (view(); as v) {
      <section class="card">
        @if (stepUpId()) {
          <p><strong>Verified.</strong> You can make one change in the next five minutes.</p>
        } @else {
          <p class="muted">Changes need a fresh multi-factor sign-in. Verify, then make one change.</p>
          <button (click)="verify()">Verify to make a change</button>
        }
        <label>Reason for the change (kept in the audit)<textarea rows="2" [(ngModel)]="reason"></textarea></label>
      </section>

      <section class="card"><h2>Policy</h2>
        <label class="check"><input type="checkbox" [(ngModel)]="policy.passwordEnabled">Password sign-in</label>
        <label class="check"><input type="checkbox" [(ngModel)]="policy.emailCodeEnabled">Email code sign-in</label>
        <label>Minimum assurance<select [(ngModel)]="policy.minimumAssurance">
          @for (level of levels; track level.value) { <option [value]="level.value">{{level.label}}</option> }
        </select></label>
        <p class="muted">Passwords can be switched off only while two administrators can still sign in another way.
          Switching passwords back on always works.</p>
        <button [disabled]="!canChange()" (click)="savePolicy()">Save policy</button>
      </section>

      @for (shared of v.shared; track shared.id) {
        <section class="card"><h2>{{shared.label}} <span class="muted">(shared provider)</span></h2>
          <p class="muted">{{shared.issuer}}
            @if (shared.allowedDomains.length) { · installation domains {{shared.allowedDomains.join(', ')}} }</p>
          <ng-container *ngTemplateOutlet="optIn; context: { id: shared.id }" />
          <button class="secondary" (click)="test(shared.id)">Test connection</button>
          <ng-container *ngTemplateOutlet="checks; context: { id: shared.id }" />
        </section>
      } @empty {
        <section class="card"><h2>Shared provider</h2><p class="muted">This installation has no shared sign-in provider.</p></section>
      }

      @for (own of v.own; track own.id) {
        <section class="card"><h2>{{own.label}} <span class="muted">({{own.id}})</span></h2>
          <p class="muted">{{own.issuer}} · client {{own.clientId}} · domains {{own.allowedDomains.join(', ')}}
            · secret {{own.secretSet ? 'stored' : 'missing'}} · changed {{own.updatedAt}}</p>
          <ng-container *ngTemplateOutlet="optIn; context: { id: own.id }" />
          <button class="secondary" (click)="edit(own)">Edit</button>
          <button class="secondary" (click)="test(own.id)">Test connection</button>
          <button class="danger" [disabled]="!canChange()" (click)="remove(own.id)">Remove</button>
          <ng-container *ngTemplateOutlet="checks; context: { id: own.id }" />
        </section>
      }

      <section class="card"><h2>{{form.existing ? 'Edit provider ' + form.id : "Add the organisation's own provider"}}</h2>
        <p class="muted">An OpenID Connect provider the organisation runs, such as Microsoft Entra ID, Okta or its own Google Workspace.
          Register the redirect address the main app shows in its settings. A new provider starts switched off.</p>
        <label>Id (lowercase letters, digits or -)<input [(ngModel)]="form.id" [disabled]="form.existing"></label>
        <label>Label on the sign-in page<input [(ngModel)]="form.label"></label>
        <label>Issuer<input [(ngModel)]="form.issuer"></label>
        <label>Client id<input [(ngModel)]="form.clientId"></label>
        <label>Client secret<input type="password" autocomplete="new-password" [(ngModel)]="form.clientSecret"
          [placeholder]="form.existing ? 'Stored. Leave empty to keep it.' : ''"></label>
        <label>Email domains it may sign in (comma separated)<input [(ngModel)]="form.domains"></label>
        <button [disabled]="!canChange()" (click)="saveProvider()">Save provider</button>
        @if (form.existing) { <button class="secondary" (click)="form = blank()">Cancel</button> }
      </section>
    }

    <ng-template #optIn let-id="id">
      @if (optIns[id]; as o) {
        <label class="check"><input type="checkbox" [(ngModel)]="o.enabled">Offered on the sign-in page</label>
        <label>Assurance it gives<select [(ngModel)]="o.assurance">
          @for (level of levels; track level.value) { <option [value]="level.value">{{level.label}}</option> }
        </select></label>
        <label>Only these email domains (comma separated, empty for no extra limit)<input [(ngModel)]="o.domains"></label>
        <button [disabled]="!canChange()" (click)="saveOptIn(id)">Save opt-in</button>
      }
    </ng-template>
    <ng-template #checks let-id="id">
      @if (results()[id]; as r) {
        <ul class="checks">@for (c of r.checks; track c.name) { <li [class.error]="!c.ok">{{c.ok ? 'OK' : 'Failed'}}: {{c.name}}. {{c.message}}</li> }</ul>
      }
    </ng-template>`,
})
export class SignInScreen {
  private readonly api = inject(OperatorApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly code = signal(this.route.snapshot.queryParamMap.get('code') ?? '');
  readonly stepUpId = signal(this.route.snapshot.queryParamMap.get('stepUpId') ?? '');
  readonly view = signal<OperatorSignInContract | null>(null);
  readonly error = signal('');
  readonly notice = signal('');
  readonly results = signal<Record<string, OperatorProviderCheckContract>>({});
  readonly levels: { value: OperatorAssuranceContract; label: string }[] = [
    { value: 'aal1', label: 'Single factor (aal1)' },
    { value: 'aal2', label: 'Multi-factor (aal2)' },
    { value: 'aal3', label: 'Hardware-backed multi-factor (aal3)' },
  ];
  policy: OperatorSignInContract['policy'] = { passwordEnabled: true, emailCodeEnabled: true, minimumAssurance: 'aal1' };
  optIns: Record<string, OptInForm> = {};
  form: ProviderForm = emptyProvider();
  reason = '';

  constructor() { void this.load(); }

  blank(): ProviderForm { return emptyProvider(); }
  canChange(): boolean { return !!this.stepUpId() && !!this.reason.trim(); }

  async load(): Promise<void> {
    try { this.show(await this.api.organisationSignIn(this.code())); } catch (error) { this.error.set((error as Error).message); }
  }

  async verify(): Promise<void> {
    try { await this.api.stepUp('sign_in', this.code(), `/organisations/sign-in?code=${encodeURIComponent(this.code())}`); }
    catch (error) { this.error.set((error as Error).message); }
  }

  edit(own: OperatorSignInContract['own'][number]): void {
    this.form = { id: own.id, label: own.label, issuer: own.issuer, clientId: own.clientId, clientSecret: '', domains: own.allowedDomains.join(', '), existing: true };
  }

  savePolicy(): Promise<void> {
    return this.change('Policy saved.', (c) => this.api.saveSignInPolicy(this.code(), { ...c, policy: { ...this.policy } }));
  }

  saveOptIn(id: string): Promise<void> {
    const o = this.optIns[id]!;
    return this.change('Opt-in saved.', (c) =>
      this.api.saveProviderPolicy(this.code(), id, { ...c, policy: { enabled: o.enabled, assurance: o.assurance, allowedDomains: domainList(o.domains) } }));
  }

  async saveProvider(): Promise<void> {
    const f = this.form;
    await this.change(`Provider ${f.id} saved.`, (c) => this.api.saveProvider(this.code(), f.id.trim(), {
      ...c,
      provider: { label: f.label, issuer: f.issuer.trim(), clientId: f.clientId.trim(), allowedDomains: domainList(f.domains), ...(f.clientSecret ? { clientSecret: f.clientSecret } : {}) },
    }));
    if (!this.error()) this.form = emptyProvider();
  }

  remove(id: string): Promise<void> {
    return this.change(`Provider ${id} removed.`, (c) => this.api.removeProvider(this.code(), id, c));
  }

  async test(id: string): Promise<void> {
    this.error.set('');
    try {
      const result = await this.api.testProvider(this.code(), id);
      this.results.update((all) => ({ ...all, [id]: result }));
    } catch (error) { this.error.set((error as Error).message); }
  }

  /** Uses the step-up once, whatever the outcome: the server has spent it. */
  private async change(done: string, run: (change: { reason: string; stepUpId: string }) => Promise<OperatorSignInContract>): Promise<void> {
    this.error.set(''); this.notice.set('');
    const stepUpId = this.stepUpId();
    if (!stepUpId) { this.error.set('Verify with multi-factor sign-in first.'); return; }
    this.stepUpId.set('');
    void this.router.navigate([], { queryParams: { code: this.code() }, replaceUrl: true });
    try {
      this.show(await run({ reason: this.reason.trim(), stepUpId }));
      this.reason = '';
      this.notice.set(done);
    } catch (error) {
      this.error.set(`${(error as Error).message} Verify again to retry.`);
    }
  }

  private show(view: OperatorSignInContract): void {
    this.view.set(view);
    this.policy = { ...view.policy };
    this.optIns = Object.fromEntries([...view.shared, ...view.own].map((p) => [p.id, optInForm(p.optIn)]));
  }
}
