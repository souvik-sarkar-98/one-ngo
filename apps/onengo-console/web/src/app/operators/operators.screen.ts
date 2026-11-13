import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { OPERATOR_ACTIONS, type OperatorAccountContract, type OperatorActionContract } from '@onengo/platform/contracts';
import { FormProblems } from '@onengo/web-kit';
import { OperatorApi, OperatorRequestError } from '../services/operator-api';
import { clearPending, readPending, readStored, returnPath, savePending } from '../services/pending-step';

const LABELS: Record<OperatorActionContract, string> = {
  status: 'Look up organisations', onboard: 'Onboard', retry: 'Retry onboarding', suspend: 'Suspend',
  reactivate: 'Reactivate', close: 'Close', sign_in: 'Change sign-in', operators: 'Manage operators', audit: 'Read activity',
};
const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'The request failed.';
const problemsOf = (error: unknown): string[] => error instanceof OperatorRequestError ? error.problems : [];
const isAction = (value: string): value is OperatorActionContract => (OPERATOR_ACTIONS as readonly string[]).includes(value);

@Component({
  standalone: true, imports: [FormsModule, FormProblems, RouterLink],
  template: `<div class="pagehead"><h1>Operators</h1><span class="sp"></span>
      @if (api.can('operators')) { <button type="button" class="sm" (click)="startAdd()">Add operator</button> }
    </div>
    @if (!api.can('operators')) { <p class="note">Managing operators needs the Manage operators action.</p> }
    @else {
      <p class="intro">People who can sign in to this console, and what each of them can do.</p>
      <div class="search"><span aria-hidden="true">⌕</span><input name="q" [(ngModel)]="q" placeholder="Search by name" (ngModelChange)="load()"></div>
      <div class="chips">
        <button type="button" [class.on]="status === 'active'" (click)="filter('active')">Active {{ count('active') }}</button>
        <button type="button" [class.on]="status === 'disabled'" (click)="filter('disabled')">Disabled {{ count('disabled') }}</button>
        <button type="button" [class.on]="status === ''" (click)="filter('')">All</button>
      </div>
      <app-form-problems [message]="error()" />
      @if (adding()) {
        <section class="sheet">
          <h2>Add operator</h2>
          @if (stepUpReady()) { <p class="note ok">Verification is complete. Add the operator.</p> }
          <label>Name<input name="displayName" [(ngModel)]="displayName"></label>
          <label>Subject id<input name="subject" [(ngModel)]="subject"></label>
          <p class="muted">The login is this console's identity provider plus the subject id.</p>
          <div class="chips">
            <button type="button" (click)="preset(['status'])">Look up</button>
            <button type="button" (click)="preset(['status','onboard','retry','suspend','reactivate','close','sign_in'])">Operate</button>
            <button type="button" (click)="preset(actions)">Everything</button>
          </div>
          @for (action of actions; track action) {
            <label class="check"><input type="checkbox" [checked]="chosen().includes(action)" (change)="toggle(action)">{{ label(action) }}</label>
          }
          <div class="row">
            <button type="button" class="ghost" (click)="adding.set(false)">Cancel</button>
            <button type="button" [disabled]="!displayName.trim() || !subject.trim()" (click)="create()">Continue</button>
          </div>
        </section>
      }
      <div class="list">
        @for (row of shown(); track row.id) {
          <a class="line" [routerLink]="['/operators', row.id]">
            <span class="who"><b>{{ row.displayName }}</b><span class="muted">{{ row.actions.length }} {{ row.actions.length === 1 ? 'action' : 'actions' }}@if (row.identities[0]?.subject) { · {{ row.identities[0]?.subject }} }</span></span>
            <span class="badge" [class.ok]="row.status === 'active'" [class.bad]="row.status === 'disabled'">{{ row.status === 'active' ? 'Active' : 'Disabled' }}</span>
          </a>
        } @empty { <p class="muted" style="padding:12px">No operator matches.</p> }
      </div>
    }`,
})
export class OperatorsScreen {
  readonly api = inject(OperatorApi);
  readonly actions = OPERATOR_ACTIONS;
  readonly rows = signal<OperatorAccountContract[]>([]);
  readonly error = signal('');
  readonly adding = signal(false);
  readonly stepUpReady = signal(false);
  readonly chosen = signal<OperatorActionContract[]>(['status']);
  q = '';
  status: '' | 'active' | 'disabled' = 'active';
  private loaded: OperatorAccountContract[] = [];
  displayName = '';
  subject = '';
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  constructor() {
    const pending = this.route.snapshot.queryParamMap.get('stepUpId') ? readStored() : undefined;
    if (pending?.action === 'operators' && pending.payload['kind'] === 'create') {
      this.adding.set(true);
      this.stepUpReady.set(true);
      this.displayName = pending.payload['displayName'] ?? '';
      this.subject = pending.payload['subject'] ?? '';
      this.chosen.set((pending.payload['actions'] ?? '').split(',').filter(isAction));
    }
    void this.load();
  }
  label(action: OperatorActionContract): string { return LABELS[action]; }
  filter(status: '' | 'active' | 'disabled'): void { this.status = status; this.apply(); }
  count(status: 'active' | 'disabled'): number { return this.loaded.filter((row) => row.status === status).length; }
  shown(): OperatorAccountContract[] { return this.rows(); }
  startAdd(): void { this.adding.set(true); this.stepUpReady.set(false); }
  preset(actions: readonly OperatorActionContract[]): void { this.chosen.set([...actions]); }
  toggle(action: OperatorActionContract): void {
    const current = this.chosen();
    this.chosen.set(current.includes(action) ? current.filter((item) => item !== action) : [...current, action]);
  }
  async load(): Promise<void> {
    this.error.set('');
    try {
      this.loaded = (await this.api.operators({ q: this.q.trim() })).operators;
      this.apply();
    } catch (error) { this.error.set(messageOf(error)); }
  }
  private apply(): void {
    this.rows.set(this.status ? this.loaded.filter((row) => row.status === this.status) : this.loaded);
  }
  async create(): Promise<void> {
    const stepUpId = this.route.snapshot.queryParamMap.get('stepUpId');
    const pending = stepUpId ? readPending('operators', this.subject.trim()) : undefined;
    try {
      if (!stepUpId || pending?.payload['kind'] !== 'create') {
        savePending({ action: 'operators', target: this.subject.trim(), payload: { kind: 'create', displayName: this.displayName.trim(), subject: this.subject.trim(), actions: this.chosen().join(',') } });
        await this.api.stepUp('operators', this.subject.trim(), '/operators');
        return;
      }
      const created = await this.api.createOperator({ displayName: this.displayName.trim(), subject: this.subject.trim(), actions: this.chosen(), stepUpId });
      clearPending();
      this.adding.set(false);
      await this.load();
      await this.router.navigate(['/operators', created.id]);
    } catch (error) { this.error.set(messageOf(error)); }
  }
}

@Component({
  standalone: true, imports: [FormsModule, FormProblems, RouterLink],
  template: `<div class="pagehead"><h1>{{ account()?.displayName || 'Operator' }}</h1>
      @if (account(); as person) { <span class="badge" [class.ok]="person.status === 'active'" [class.bad]="person.status === 'disabled'">{{ person.status === 'active' ? 'Active' : 'Disabled' }}</span> }
    </div>
    <app-form-problems [message]="error()" [problems]="problems()" />
    @if (account(); as person) {
      <section class="card">
        <h2>Account</h2>
        <div class="kv">
          <div><b>Provider</b><span><code>{{ person.identities[0]?.issuer || '—' }}</code></span></div>
          <div><b>Subject</b><span><code>{{ person.identities[0]?.subject || '—' }}</code></span></div>
          @if (person.disabledReason) { <div><b>Disabled</b><span>{{ person.disabledReason }}</span></div> }
        </div>
        @if (mine()) { <p class="note">This is your account. You can change other actions, and you cannot remove Manage operators, change your login, or disable yourself.</p> }
      </section>
      @if (person.status === 'active') {
        <section class="card"><h2>Actions</h2>
          @if (stepUpReady() === 'grants') { <p class="note ok">Verification is complete. Save the actions.</p> }
          @for (action of actions; track action) {
            <label class="check"><input type="checkbox" [checked]="selected().includes(action)" [disabled]="mine() && action === 'operators'" (change)="toggle(action)">{{ label(action) }}</label>
          }
        </section>
        @if (dirty()) { <div class="bar"><span>Unsaved action changes</span><button type="button" (click)="save()">Save</button></div> }
        @if (!mine()) {
          <section class="card"><h2>Login</h2>
            @if (sheet() === 'login') {
              @if (stepUpReady() === 'login') { <p class="note ok">Verification is complete. Save the new subject id.</p> }
              <label>New subject id<input name="subject" [(ngModel)]="subject"></label>
              <div class="row"><button type="button" class="ghost" (click)="sheet.set('')">Cancel</button><button type="button" (click)="relink()">Save login</button></div>
            } @else { <button type="button" class="ghost" (click)="sheet.set('login')">Change login</button> }
          </section>
          <section class="card"><h2>Disable</h2>
            @if (sheet() === 'disable') {
              @if (stepUpReady() === 'disable') { <p class="note ok">Verification is complete. Confirm to disable this operator.</p> }
              <label>Reason<textarea name="reason" [(ngModel)]="reason"></textarea></label>
              <div class="row"><button type="button" class="ghost" (click)="sheet.set('')">Cancel</button><button type="button" class="danger" [disabled]="!reason.trim()" (click)="disable()">Disable</button></div>
            } @else { <button type="button" class="danger ghost" (click)="sheet.set('disable')">Disable</button> }
          </section>
        }
      }
      <p><a routerLink="/operators">All operators</a></p>
    }`,
})
export class OperatorScreen {
  readonly api = inject(OperatorApi);
  readonly actions = OPERATOR_ACTIONS;
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly id = signal(this.route.snapshot.paramMap.get('id') ?? '');
  readonly account = signal<OperatorAccountContract | null>(null);
  readonly selected = signal<OperatorActionContract[]>([]);
  readonly saved = signal<OperatorActionContract[]>([]);
  readonly dirty = computed(() => this.selected().slice().sort().join() !== this.saved().slice().sort().join());
  readonly mine = computed(() => !!this.id() && this.api.session()?.operatorId === this.id());
  readonly error = signal('');
  readonly problems = signal<string[]>([]);
  readonly sheet = signal<'' | 'login' | 'disable'>('');
  readonly stepUpReady = signal<'' | 'grants' | 'login' | 'disable'>('');
  subject = '';
  reason = '';
  constructor() {
    const pending = this.route.snapshot.queryParamMap.get('stepUpId') ? readPending('operators', this.id()) : undefined;
    const kind = pending?.payload['kind'];
    if (kind === 'grants') {
      this.selected.set((pending?.payload['actions'] ?? '').split(',').filter(isAction));
      this.stepUpReady.set('grants');
    } else if (kind === 'login') {
      this.sheet.set('login'); this.subject = pending?.payload['subject'] ?? ''; this.stepUpReady.set('login');
    } else if (kind === 'disable') {
      this.sheet.set('disable'); this.reason = pending?.payload['reason'] ?? ''; this.stepUpReady.set('disable');
    }
    void this.load();
  }
  label(action: OperatorActionContract): string { return LABELS[action]; }
  toggle(action: OperatorActionContract): void {
    if (this.mine() && action === 'operators') return;
    const current = this.selected();
    this.selected.set(current.includes(action) ? current.filter((item) => item !== action) : [...current, action]);
  }
  async load(): Promise<void> {
    this.error.set('');
    try {
      const account = await this.api.operator(this.id());
      this.account.set(account);
      if (this.stepUpReady() !== 'grants') this.selected.set(account.actions);
      this.saved.set(account.actions);
    } catch (error) { this.error.set(messageOf(error)); this.problems.set(problemsOf(error)); }
  }
  async save(): Promise<void> { await this.change('grants'); }
  async relink(): Promise<void> { await this.change('login'); }
  async disable(): Promise<void> { await this.change('disable'); }
  private async change(kind: 'grants' | 'login' | 'disable'): Promise<void> {
    const stepUpId = this.route.snapshot.queryParamMap.get('stepUpId');
    const pending = stepUpId ? readPending('operators', this.id()) : undefined;
    const payload: Record<string, string> = { kind };
    if (kind === 'grants') payload['actions'] = this.selected().join(',');
    else if (kind === 'login') payload['subject'] = this.subject.trim();
    else payload['reason'] = this.reason.trim();
    try {
      if (!stepUpId || pending?.payload['kind'] !== kind) {
        savePending({ action: 'operators', target: this.id(), payload });
        await this.api.stepUp('operators', this.id(), returnPath());
        return;
      }
      const body = kind === 'grants'
        ? await this.api.saveGrants(this.id(), { actions: this.selected(), stepUpId })
        : kind === 'login'
          ? await this.api.relinkOperator(this.id(), { subject: this.subject.trim(), stepUpId })
          : await this.api.disableOperator(this.id(), { reason: this.reason.trim(), stepUpId });
      clearPending();
      this.account.set(body);
      this.selected.set(body.actions);
      this.saved.set(body.actions);
      this.sheet.set('');
      this.stepUpReady.set('');
      await this.router.navigate([], { queryParams: { stepUpId: null }, queryParamsHandling: 'merge' });
    } catch (error) { this.error.set(messageOf(error)); this.problems.set(problemsOf(error)); }
  }
}
