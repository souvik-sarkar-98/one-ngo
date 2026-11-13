import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { OperatorActivityEntryContract } from '@onengo/platform/contracts';
import { FormProblems } from '@onengo/web-kit';
import { OperatorApi, OperatorRequestError } from '../services/operator-api';

const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'The request failed.';
const problemsOf = (error: unknown): string[] => error instanceof OperatorRequestError ? error.problems : [];

@Component({
  standalone: true, imports: [FormsModule, FormProblems],
  template: `<div class="pagehead"><h1>Activity</h1></div>
    @if (!api.can('audit')) { <p class="note">Reading activity needs the Read activity action.</p> }
    @else {
      <p class="intro">Everything operators did in the console, newest first. Entries cannot be changed or deleted.</p>
      <div class="search"><span aria-hidden="true">⌕</span><input name="q" [(ngModel)]="q" placeholder="Organisation code, request ID or operator" (ngModelChange)="load()"></div>
      <div class="chips">
        <button type="button" [class.on]="range === 'today'" (click)="setRange('today')">Today</button>
        <button type="button" [class.on]="range === '7'" (click)="setRange('7')">7 days</button>
        <button type="button" [class.on]="range === '30'" (click)="setRange('30')">30 days</button>
        <button type="button" [class.on]="range === 'all'" (click)="setRange('all')">All</button>
      </div>
      <app-form-problems [message]="error()" [problems]="problems()" />
      <table class="wide">
        <thead><tr><th>Time</th><th>Who</th><th>What</th><th>On</th></tr></thead>
        <tbody>
          @for (entry of entries(); track entry.id) {
            <tr class="click" (click)="open(entry)"><td>{{ when(entry.at) }}</td><td>{{ entry.operator }}</td><td>{{ entry.action }}</td><td>{{ entry.requestId || '—' }}</td></tr>
          } @empty { <tr><td colspan="4">No activity matches.</td></tr> }
        </tbody>
      </table>
      <div class="rows list">
        @for (entry of entries(); track entry.id) {
          <button type="button" class="line" (click)="open(entry)"><span>{{ entry.action }}<br><span class="muted">{{ entry.operator }}</span></span><span class="muted">{{ when(entry.at) }}</span></button>
        }
      </div>
      @if (selected(); as entry) {
        <section class="sheet">
          <h2>{{ entry.action }}</h2>
          <div class="kv">
            <div><b>When</b><span>{{ when(entry.at) }}</span></div>
            <div><b>Operator</b><span>{{ entry.operator }}</span></div>
            <div><b>Permission</b><span>{{ entry.permission || '—' }}</span></div>
            <div><b>Request</b><span>{{ entry.requestId || '—' }}</span></div>
            <div><b>Provider</b><code>{{ entry.issuer || '—' }}</code></div>
            <div><b>Subject</b><code>{{ entry.subject || '—' }}</code></div>
          </div>
          @if (entry.detail) { <pre>{{ json(entry.detail) }}</pre> }
          <div class="row"><button type="button" class="ghost" (click)="selected.set(null)">Close</button><span class="sp"></span><button type="button" class="ghost" (click)="download()">Download CSV</button></div>
        </section>
      } @else {
        <div class="row"><span class="sp"></span><button type="button" class="ghost" (click)="download()">Download CSV</button></div>
      }
    }`,
})
export class ActivityScreen {
  readonly api = inject(OperatorApi);
  readonly entries = signal<OperatorActivityEntryContract[]>([]);
  readonly selected = signal<OperatorActivityEntryContract | null>(null);
  readonly error = signal('');
  readonly problems = signal<string[]>([]);
  q = '';
  action = '';
  from = '';
  to = '';
  range: 'today' | '7' | '30' | 'all' = '30';
  constructor() { this.setRange('30'); }
  setRange(range: 'today' | '7' | '30' | 'all'): void {
    this.range = range;
    const today = new Date();
    const day = (date: Date) => date.toISOString().slice(0, 10);
    if (range === 'all') { this.from = ''; this.to = ''; }
    else {
      const start = new Date(today);
      if (range === '7') start.setDate(start.getDate() - 6);
      if (range === '30') start.setDate(start.getDate() - 29);
      this.from = day(start);
      this.to = day(today);
    }
    void this.load();
  }
  when(value: string): string { return new Date(value).toLocaleString(); }
  json(value: unknown): string { return JSON.stringify(value, null, 2); }
  open(entry: OperatorActivityEntryContract): void { this.selected.set(entry); }
  private query() {
    return { q: this.q.trim(), action: this.action.trim(), from: this.from, to: this.to ? `${this.to}T23:59:59.999Z` : '' };
  }
  async load(): Promise<void> {
    this.error.set(''); this.problems.set([]);
    try { this.entries.set((await this.api.activity(this.query())).entries); }
    catch (error) { this.error.set(messageOf(error)); this.problems.set(problemsOf(error)); }
  }
  async download(): Promise<void> {
    try {
      const csv = await this.api.activityCsv(this.query());
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'operator-activity.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) { this.error.set(messageOf(error)); }
  }
}
