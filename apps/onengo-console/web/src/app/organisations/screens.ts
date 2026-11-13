import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { OperatorOnboardResult, OperatorOrganisationSummary, OperatorStatusContract } from '@onengo/platform/contracts';
import { FormProblems } from '@onengo/web-kit';
import { OperatorApi, OperatorRequestError } from '../services/operator-api';
import { clearPending, readPending, returnPath, savePending } from '../services/pending-step';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'The request failed.';
const problemsOf = (error: unknown): string[] => error instanceof OperatorRequestError ? error.problems : [];
const detailText = (detail: unknown): string => {
  if (!detail || typeof detail !== 'object' || !('reason' in detail)) return '';
  const reason = (detail as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : '';
};

const ORG_STATUS: Record<string, string> = {
  active: 'Active', suspended: 'Suspended', closed: 'Closed', provisioning: 'Setting up', provisioning_failed: 'Failed',
};

@Component({
  standalone: true, imports: [FormsModule, RouterLink, FormProblems],
  template: `<div class="pagehead"><h1>Organisations</h1></div>
    @if (!api.can('status')) {
      <p class="note">You can open the destinations in the menu. Looking up an organisation needs the look-up action.</p>
    } @else {
      <p class="intro">Look up one organisation by its code, or an onboarding request by its ID. The list below is every organisation on this installation.</p>
      @if (miss()) { <p class="note bad">{{ miss() }}</p> }
      <section class="card">
        <div class="seg">
          <button type="button" [class.on]="kind === 'code'" (click)="kind = 'code'">Organisation code</button>
          <button type="button" [class.on]="kind === 'requestId'" (click)="kind = 'requestId'">Request ID</button>
        </div>
        <form (ngSubmit)="find()">
          <div class="search" [class.bad]="!!miss()">
            <span aria-hidden="true">⌕</span>
            <input name="ref" [(ngModel)]="value" [placeholder]="kind === 'code' ? 'e.g. riverbank' : 'Request ID'" autocomplete="off" (ngModelChange)="miss.set('')">
          </div>
          <div class="row"><span class="sp"></span><button type="submit" [disabled]="!value.trim()">Find</button></div>
        </form>
      </section>
      <app-form-problems [message]="error()" />
      <div class="chips">
        <button type="button" [class.on]="status === ''" (click)="status = ''">All {{ organisations().length }}</button>
        <button type="button" [class.on]="status === 'active'" (click)="status = 'active'">Active {{ count('active') }}</button>
        <button type="button" [class.on]="status === 'suspended'" (click)="status = 'suspended'">Suspended {{ count('suspended') }}</button>
        <button type="button" [class.on]="status === 'closed'" (click)="status = 'closed'">Closed {{ count('closed') }}</button>
      </div>
      <div class="list">
        @for (org of shown(); track org.code) {
          <a class="line" [routerLink]="['/organisations/status']" [queryParams]="{ code: org.code }">
            <span class="who"><b>{{ org.displayName }}</b><span class="muted">{{ org.code }}@if (org.region) { · {{ org.region }} }</span></span>
            <span class="badge" [class.ok]="org.status === 'active'" [class.warn]="org.status === 'suspended'" [class.bad]="org.status === 'provisioning_failed' || org.status === 'closed'">{{ label(org.status) }}</span>
          </a>
        } @empty { <p class="muted" style="padding:12px">No organisation matches.</p> }
      </div>
    }`,
})
export class FindScreen {
  readonly api = inject(OperatorApi);
  readonly organisations = signal<OperatorOrganisationSummary[]>([]);
  readonly error = signal('');
  readonly miss = signal('');
  value = '';
  kind: 'code' | 'requestId' = 'code';
  status = '';
  private readonly router = inject(Router);
  constructor() { void this.load(); }
  label(status: string): string { return ORG_STATUS[status] ?? status; }
  count(status: string): number { return this.organisations().filter((org) => org.status === status).length; }
  shown(): OperatorOrganisationSummary[] {
    const q = this.kind === 'code' ? this.value.trim().toLowerCase() : '';
    return this.organisations().filter((org) => {
      if (this.status && org.status !== this.status) return false;
      if (!q) return true;
      return org.code.includes(q) || org.displayName.toLowerCase().includes(q) || (org.legalName ?? '').toLowerCase().includes(q);
    });
  }
  async load(): Promise<void> {
    this.error.set('');
    try { this.organisations.set((await this.api.organisations()).organisations); }
    catch (error) { this.error.set(messageOf(error)); }
  }
  async find(): Promise<void> {
    const ref = this.value.trim();
    if (!ref) return;
    this.miss.set('');
    if (this.kind === 'requestId') {
      await this.router.navigate(['/organisations/status'], { queryParams: { requestId: ref } });
      return;
    }
    try {
      const status = await this.api.status({ code: ref.toLowerCase() });
      const org = status.organisation;
      if (!org) { this.miss.set(`No organisation has the code ${ref}. Check the spelling, or switch to Request ID.`); return; }
      await this.router.navigate(['/organisations/status'], { queryParams: { code: org.code } });
    } catch (error) {
      this.miss.set(messageOf(error));
    }
  }
}

@Component({
  standalone: true, imports: [FormsModule, FormProblems, RouterLink],
  template: `<app-form-problems [message]="error()" [problems]="problems()" />
    @if (status(); as value) {
      @if (value.organisation; as org) {
        <div class="pagehead">
          <h1>{{ org.displayName }}</h1>
          <span class="badge" [class.ok]="org.status === 'active'" [class.warn]="org.status === 'suspended'" [class.bad]="org.status === 'closed' || org.status === 'provisioning_failed'">{{ orgLabel(org.status) }}</span>
        </div>
        <section class="card">
          <h2>Organisation</h2>
          <div class="kv">
            <div><b>Code</b><span>{{ org.code }}</span></div>
            <div><b>Legal name</b><span>{{ org.legalName || '—' }}</span></div>
            <div><b>Region</b><span>{{ org.region || '—' }}</span></div>
            <div><b>Opened</b><span>{{ when(org.createdAt) }}</span></div>
          </div>
        </section>
        @if (org.status === 'closed') {
          <p class="note">This organisation is closed. Members cannot sign in, and it cannot be reopened from the console.</p>
        } @else {
          <section class="card"><h2>Lifecycle</h2>
            <p class="muted">{{ org.status === 'suspended' ? 'Members cannot sign in. Records are kept.' : 'Suspending stops members signing in and keeps every record. Closing is permanent.' }}</p>
            <div class="row">
              @if (org.status === 'active' && api.can('suspend')) { <button type="button" class="danger ghost" (click)="open('suspend')">Suspend</button> }
              @if (org.status === 'suspended' && api.can('reactivate')) { <button type="button" (click)="open('reactivate')">Reactivate</button> }
              @if ((org.status === 'suspended' || org.status === 'provisioning_failed') && api.can('close')) { <button type="button" class="danger" (click)="open('close')">Close</button> }
            </div>
          </section>
        }
        @if (api.can('sign_in') && org.status !== 'closed') {
          <section class="card"><h2>Sign-in</h2>
            <p class="muted">How members of this organisation sign in.</p>
            <div class="row"><span class="sp"></span><a routerLink="/organisations/sign-in" [queryParams]="{ code: org.code }">Change sign-in</a></div>
          </section>
        }
      } @else {
        <div class="pagehead"><h1>Onboarding request</h1></div>
        <p class="note">This request has not created an organisation yet.</p>
      }
      @if (value.onboarding; as request) {
        <section class="card"><h2>Onboarding</h2>
          <div class="kv">
            <div><b>Request</b><span>{{ request.requestId }}</span></div>
            <div><b>State</b><span>{{ request.state }}</span></div>
            <div><b>Step</b><span>{{ request.step }}</span></div>
            <div><b>Invitation</b><span>{{ request.invitation }}</span></div>
          </div>
          @if (request.failure) { <p class="note bad">{{ request.failure.message }}</p> }
          @if (request.state === 'provisioning_failed' && api.can('retry')) { <button type="button" (click)="retry()">Retry</button> }
        </section>
      }
      @if (value.history.length) {
        <section class="card"><h2>History</h2>
          <div class="list">
            @for (entry of value.history; track entry.at + entry.action) {
              <div class="line"><span>{{ entry.action }}</span><span class="muted">{{ entry.operator }} · {{ when(entry.at) }}</span></div>
              @if (detailText(entry.detail)) { <p class="muted">{{ detailText(entry.detail) }}</p> }
            }
          </div>
        </section>
      }
    }
    @if (sheet(); as action) {
      <section class="sheet">
        <h2>{{ action }}</h2>
        @if (stepUpReady()) { <p class="note ok">Verification is complete. Confirm to finish.</p> }
        <label>Reason<textarea name="reason" [(ngModel)]="reason"></textarea></label>
        @if (action === 'close') { <label>Type {{ code() }} to confirm<input name="confirm" [(ngModel)]="confirmCode" autocomplete="off"></label> }
        <div class="row">
          <button type="button" class="ghost" (click)="sheet.set('')">Cancel</button>
          <button type="button" [class.danger]="action !== 'reactivate'" [disabled]="!canConfirm()" (click)="commit()">Confirm</button>
        </div>
      </section>
    }`,
})
export class StatusScreen {
  readonly api = inject(OperatorApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly status = signal<OperatorStatusContract | null>(null);
  readonly error = signal('');
  readonly problems = signal<string[]>([]);
  readonly code = signal(this.route.snapshot.queryParamMap.get('code') ?? '');
  readonly requestId = signal(this.route.snapshot.queryParamMap.get('requestId') ?? '');
  readonly sheet = signal<'' | 'suspend' | 'reactivate' | 'close'>('');
  readonly stepUpReady = signal(false);
  reason = '';
  confirmCode = '';
  constructor() {
    const stepUpId = this.route.snapshot.queryParamMap.get('stepUpId');
    for (const action of ['suspend', 'reactivate', 'close'] as const) {
      const pending = stepUpId ? readPending(action, this.code()) : undefined;
      if (pending) { this.sheet.set(action); this.reason = pending.payload['reason'] ?? ''; this.stepUpReady.set(true); }
    }
    void this.load();
  }
  when(value: string): string { return new Date(value).toLocaleString(); }
  orgLabel(status: string): string { return ORG_STATUS[status] ?? status; }
  detailText = detailText;
  open(action: 'suspend' | 'reactivate' | 'close'): void { this.sheet.set(action); this.stepUpReady.set(false); }
  canConfirm(): boolean { return this.sheet() !== 'close' || this.confirmCode.trim().toLowerCase() === this.code(); }
  async load(): Promise<void> {
    this.error.set(''); this.problems.set([]);
    try { this.status.set(await this.api.status({ code: this.code() || undefined, requestId: this.requestId() || undefined })); }
    catch (error) { this.error.set(messageOf(error)); this.problems.set(problemsOf(error)); }
  }
  async retry(): Promise<void> {
    try { await this.api.retry(this.requestId()); await this.load(); }
    catch (error) { this.error.set(messageOf(error)); }
  }
  async commit(): Promise<void> {
    const action = this.sheet();
    const target = this.code();
    if (!action || !target || !this.canConfirm()) return;
    const stepUpId = this.route.snapshot.queryParamMap.get('stepUpId');
    const pending = stepUpId ? readPending(action, target) : undefined;
    try {
      if (!stepUpId || !pending) {
        savePending({ action, target, payload: { reason: this.reason } });
        await this.api.stepUp(action, target, returnPath());
        return;
      }
      await this.api.lifecycle(action, target, { reason: this.reason, stepUpId });
      clearPending();
      this.sheet.set('');
      this.stepUpReady.set(false);
      await this.router.navigate([], { queryParams: { stepUpId: null }, queryParamsHandling: 'merge' });
      await this.load();
    } catch (error) { this.error.set(messageOf(error)); this.problems.set(problemsOf(error)); }
  }
}

interface RegistrationDraft { type: string; number: string }

@Component({
  standalone: true, imports: [FormsModule, FormProblems, RouterLink],
  template: `<div class="pagehead"><h1>Onboard an organisation</h1></div>
    @if (!api.can('onboard')) { <p class="note">Onboarding needs the onboard action.</p> }
    @else if (done(); as result) {
      <section class="card">
        <p class="note ok">{{ result.displayName }} is onboarded.</p>
        <div class="kv">
          <div><b>Code</b><span>{{ result.code }}</span></div>
          <div><b>Request</b><span>{{ result.requestId }}</span></div>
          <div><b>Status</b><span>{{ result.status }}</span></div>
          <div><b>Step</b><span>{{ result.step }}</span></div>
          <div><b>Invitation</b><span>{{ result.invitation }}</span></div>
        </div>
        @if (result.failure) { <p class="note bad">{{ result.failure.message }}</p> }
        <a routerLink="/organisations/status" [queryParams]="{ code: result.code }">Open the organisation</a>
      </section>
    } @else if (review()) {
      <section class="card">
        <h2>Review</h2>
        <div class="kv">
          <div><b>Code</b><span>{{ code }}</span></div>
          <div><b>Name</b><span>{{ displayName }}</span></div>
          <div><b>Administrator</b><span>{{ adminName }} · {{ adminEmail }}</span></div>
          <div><b>Modules</b><span>{{ modules }}</span></div>
        </div>
        <app-form-problems [message]="error()" [problems]="problems()" />
        <div class="row"><button type="button" class="ghost" (click)="review.set(false)">Back</button><button type="button" (click)="submit()">Onboard {{ displayName || 'organisation' }}</button></div>
      </section>
    } @else {
      <p class="intro">Fill in the sections, then Check. Nothing is written until you choose Onboard on the review.</p>
      <form (ngSubmit)="validate()">
        <div class="sect"><span class="n">1</span>Organisation</div>
        <section class="card">
          <div class="grid">
            <label>Request id<input name="requestId" [(ngModel)]="requestId"></label>
            <label>Code<input name="code" [(ngModel)]="code" (ngModelChange)="checked.set(false)"></label>
            <label>Display name<input name="displayName" [(ngModel)]="displayName" (ngModelChange)="checked.set(false)"></label>
            <label>Legal name<input name="legalName" [(ngModel)]="legalName" (ngModelChange)="checked.set(false)"></label>
          </div>
        </section>
        <div class="sect"><span class="n">2</span>Contact and address</div>
        <section class="card">
          <div class="grid">
            <label>Email<input name="email" [(ngModel)]="email" (ngModelChange)="checked.set(false)"></label>
            <label>Phone<input name="phone" [(ngModel)]="phone" (ngModelChange)="checked.set(false)"></label>
            <label>Website<input name="website" [(ngModel)]="website" (ngModelChange)="checked.set(false)"></label>
            <label>Address<input name="line1" [(ngModel)]="line1" (ngModelChange)="checked.set(false)"></label>
            <label>Address line 2<input name="line2" [(ngModel)]="line2" (ngModelChange)="checked.set(false)"></label>
            <label>City<input name="city" [(ngModel)]="city" (ngModelChange)="checked.set(false)"></label>
            <label>State<input name="state" [(ngModel)]="stateName" (ngModelChange)="checked.set(false)"></label>
            <label>Postal code<input name="postalCode" [(ngModel)]="postalCode" (ngModelChange)="checked.set(false)"></label>
            <label>Country<input name="country" [(ngModel)]="country" maxlength="2" (ngModelChange)="checked.set(false)"></label>
            <label>Time zone<input name="timezone" [(ngModel)]="timezone" (ngModelChange)="checked.set(false)"></label>
            <label>Language
              <select name="language" [(ngModel)]="language" (ngModelChange)="checked.set(false)">
                @for (code of languages; track code) { <option [value]="code">{{ code }}</option> }
              </select>
            </label>
            <label>Region<input name="region" [(ngModel)]="region" (ngModelChange)="checked.set(false)"></label>
          </div>
        </section>
        <div class="sect"><span class="n">3</span>First administrator</div>
        <section class="card">
          <div class="grid">
            <label>Name<input name="adminName" [(ngModel)]="adminName" (ngModelChange)="checked.set(false)"></label>
            <label>Email<input name="adminEmail" [(ngModel)]="adminEmail" (ngModelChange)="checked.set(false)"></label>
          </div>
        </section>
        <div class="sect"><span class="n">4</span>Modules and finance</div>
        <section class="card">
          <div class="grid">
            <label>Module keys<input name="modules" [(ngModel)]="modules" (ngModelChange)="checked.set(false)"></label>
            <label>Financial year starts in month<input name="startMonth" type="number" min="1" max="12" [(ngModel)]="startMonth" (ngModelChange)="checked.set(false)"></label>
            <label>Year to open<input name="fiscalYear" [(ngModel)]="fiscalYear" (ngModelChange)="checked.set(false)"></label>
            <label>Receipt prefix<input name="receiptPrefix" [(ngModel)]="receiptPrefix" (ngModelChange)="checked.set(false)"></label>
          </div>
        </section>
        <div class="sect"><span class="n">5</span>Registrations<span class="muted sp">optional</span></div>
        <section class="card">
          @for (row of registrations; track $index) {
            <div class="grid">
              <label>Type<input [name]="'type' + $index" [(ngModel)]="row.type" (ngModelChange)="checked.set(false)"></label>
              <label>Number<input [name]="'number' + $index" [(ngModel)]="row.number" (ngModelChange)="checked.set(false)"></label>
            </div>
          }
          <button type="button" class="ghost" (click)="addRegistration()">Add a registration</button>
        </section>
        <app-form-problems [message]="error()" [problems]="problems()" />
        <button type="submit">Check</button>
      </form>
    }`,
})
export class OnboardScreen {
  readonly api = inject(OperatorApi);
  readonly languages = ['en', 'hi', 'ta', 'te', 'bn', 'mr'];
  readonly checked = signal(false);
  readonly review = signal(false);
  readonly done = signal<(OperatorOnboardResult & { displayName: string }) | null>(null);
  readonly error = signal('');
  readonly problems = signal<string[]>([]);
  requestId = `onboard-${new Date().toISOString().slice(0, 10)}`;
  code = '';
  displayName = '';
  legalName = '';
  email = '';
  phone = '';
  website = '';
  line1 = '';
  line2 = '';
  city = '';
  stateName = '';
  postalCode = '';
  country = 'IN';
  timezone = 'Asia/Kolkata';
  language = 'en';
  region = 'asia-south1';
  adminName = '';
  adminEmail = '';
  modules = 'donations';
  startMonth = 4;
  fiscalYear = fiscalYear(4);
  receiptPrefix = 'RCPT';
  registrations: RegistrationDraft[] = [];
  addRegistration(): void { this.registrations = [...this.registrations, { type: '', number: '' }]; this.checked.set(false); }
  async validate(): Promise<void> { await this.run(true); }
  async submit(): Promise<void> { if (this.checked()) await this.run(false); }
  private plan(): unknown {
    const blank = (value: string): string | null => value.trim() || null;
    return {
      requestId: this.requestId.trim(),
      organisation: {
        code: this.code.trim().toLowerCase(), displayName: this.displayName.trim(), legalName: this.legalName.trim(),
        contact: { email: blank(this.email), phone: blank(this.phone), website: blank(this.website) },
        address: { line1: this.line1.trim(), line2: blank(this.line2), city: this.city.trim(), state: blank(this.stateName), postalCode: this.postalCode.trim(), country: this.country.trim().toUpperCase() },
        timezone: this.timezone.trim(), defaultLanguage: this.language, region: this.region.trim(),
        registrations: this.registrations.filter((row) => row.type.trim() && row.number.trim()).map((row) => ({
          type: row.type.trim().toLowerCase(), number: row.number.trim(), issuingAuthority: null, issuedOn: null, expiresOn: null, notes: null,
        })),
      },
      administrator: { name: this.adminName.trim(), email: this.adminEmail.trim() },
      modules: this.modules.split(/[\s,]+/).map((key) => key.trim()).filter(Boolean),
      financialYear: { startMonth: Number(this.startMonth), current: this.fiscalYear.trim() },
      receiptPrefix: this.receiptPrefix.trim() ? this.receiptPrefix.trim().toUpperCase() : null,
    };
  }
  private async run(validateOnly: boolean): Promise<void> {
    this.error.set(''); this.problems.set([]);
    try {
      const result = await this.api.onboard({ input: this.plan(), validateOnly });
      if (validateOnly) { this.checked.set(true); this.review.set(true); return; }
      this.done.set({ ...result, displayName: this.displayName.trim() });
    } catch (error) {
      this.checked.set(false); this.review.set(false);
      this.error.set(messageOf(error)); this.problems.set(problemsOf(error));
    }
  }
}

function fiscalYear(startMonth: number, today = new Date()): string {
  const year = today.getFullYear();
  if (startMonth === 1) return String(year);
  const startYear = today.getMonth() + 1 >= startMonth ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}
