import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { Btn } from '@onengo/web-kit';
import { InboxStore } from './inbox-store';
import { htmlDocument, idFromHash, senderLine, senderName, type MailPane } from './model';

const REFRESH_MS = 3000;

@Component({
  selector: 'inbox-screen',
  imports: [DatePipe, Btn],
  template: `
    <header class="bar">
      <h1>Sandbox inbox <span class="badge" aria-live="polite">{{ store.messages().length }}</span></h1>
      <input
        class="search"
        type="search"
        placeholder="Search sender, recipient or subject"
        aria-label="Search messages"
        autocomplete="off"
        [value]="store.query()"
        (input)="store.query.set($any($event.target).value)"
      />
      <label class="check auto"><input type="checkbox" [checked]="auto()" (change)="auto.set($any($event.target).checked)" /> Auto-refresh</label>
      <button type="button" appBtn="primary" (click)="store.refresh()">Refresh</button>
      <a class="api" href="/swagger">API</a>
    </header>

    @if (store.problem()) {
      <p class="notice error" role="alert">{{ store.problem() }}</p>
    }

    <main class="layout">
      <nav class="list panel" aria-label="Messages">
        @for (message of store.visible(); track message.id) {
          <button type="button" class="item" [attr.aria-current]="message.id === store.selectedId()" (click)="select(message.id)">
            <span class="item-top">
              <span class="item-from">{{ name(message) }}</span>
              <span class="item-time muted">{{ message.at | date: 'shortTime' }}</span>
            </span>
            <span class="item-subject">{{ message.subject || '(no subject)' }}</span>
            <span class="item-to muted">To: {{ message.to.join(', ') || '(no recipient)' }}</span>
          </button>
        } @empty {
          @if (store.loaded()) {
            <p class="empty muted">{{ store.messages().length ? 'No messages match your search.' : 'No messages yet.' }}</p>
          }
        }
      </nav>

      <section class="detail" aria-live="polite">
        @if (store.selected(); as message) {
          <article class="card message">
            <h2>{{ message.subject || '(no subject)' }}</h2>
            <dl class="meta">
              <dt>From</dt><dd>{{ sender(message) }}</dd>
              <dt>To</dt><dd>{{ message.to.join(', ') || '(none)' }}</dd>
              @if (message.cc.length) {
                <dt>Cc</dt><dd>{{ message.cc.join(', ') }}</dd>
              }
              <dt>Date</dt><dd>{{ message.at | date: 'medium' }}</dd>
              <dt>Id</dt><dd>{{ message.id }} (thread {{ message.threadId }})</dd>
            </dl>

            <div class="tabs" role="tablist">
              <button type="button" role="tab" [class.active]="pane() === 'html'" [attr.aria-selected]="pane() === 'html'" [disabled]="!message.html" (click)="pane.set('html')">HTML</button>
              <button type="button" role="tab" [class.active]="pane() === 'text'" [attr.aria-selected]="pane() === 'text'" (click)="pane.set('text')">Text</button>
              <button type="button" role="tab" [class.active]="pane() === 'raw'" [attr.aria-selected]="pane() === 'raw'" (click)="pane.set('raw')">Raw</button>
            </div>

            @switch (shown()) {
              @case ('html') {
                <!-- The document is a trusted string only because the iframe is sandboxed with no permissions. -->
                <iframe class="view" title="Message HTML" sandbox="" [srcdoc]="document()"></iframe>
              }
              @case ('text') {
                <pre class="view">{{ message.text || '(no plain text part)' }}</pre>
              }
              @default {
                <pre class="view">{{ store.raw() }}</pre>
              }
            }
          </article>
        } @else {
          <div class="placeholder muted">
            <p>{{ store.selectedId() === null ? 'Select a message to read it.' : 'Opening message...' }}</p>
            <p class="hint">Mail appears here after one-ngo sends through the Gmail connector. Messages are kept in memory and cleared when the sandbox restarts.</p>
          </div>
        }
      </section>
    </main>
  `,
  styles: `
    :host { display: flex; flex-direction: column; height: 100vh; background: var(--bg); }
    .bar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 10px 16px; background: var(--card); border-bottom: 1px solid var(--line); }
    .bar h1 { display: flex; align-items: center; gap: 8px; margin: 0; }
    .search { flex: 1; max-width: 420px; margin-left: auto; }
    .auto { margin: 0; white-space: nowrap; color: var(--muted); }
    .bar .api { font-weight: 600; }
    .notice { margin: 8px 16px 0; }
    .layout { flex: 1; display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 12px; min-height: 0; padding: 12px 16px; }
    .list { overflow-y: auto; }
    .item { display: flex; flex-direction: column; gap: 2px; width: 100%; border: 0; border-bottom: 1px solid var(--row-line); border-radius: 0; padding: 10px 14px; text-align: left; background: transparent; }
    .item:hover { background: var(--row-hover); }
    .item[aria-current='true'] { background: var(--row-hover); box-shadow: inset 3px 0 0 var(--brand); }
    .item-top { display: flex; justify-content: space-between; gap: 8px; }
    .item-from { font-weight: 700; }
    .item-time { flex: none; font-size: .75rem; }
    .item-from, .item-subject, .item-to { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item-to { font-size: .75rem; }
    .empty { padding: 24px 16px; text-align: center; }
    .detail { min-width: 0; overflow-y: auto; }
    .placeholder { margin-top: 12vh; text-align: center; }
    .hint { max-width: 420px; margin: 8px auto 0; font-size: .8rem; }
    .message { display: flex; flex-direction: column; gap: 10px; min-height: 100%; margin: 0; padding: 16px; }
    .message h2 { margin: 0; overflow-wrap: anywhere; }
    .meta { display: grid; grid-template-columns: 56px 1fr; gap: 2px 12px; margin: 0; }
    .meta dt { color: var(--muted); }
    .meta dd { margin: 0; overflow-wrap: anywhere; }
    .tabs { margin-bottom: 0; }
    .view { flex: 1; min-height: 320px; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); }
    iframe.view { padding: 0; width: 100%; }
    @media (max-width: 760px) {
      .search { order: 5; flex-basis: 100%; max-width: none; margin-left: 0; }
      .layout { grid-template-columns: 1fr; grid-template-rows: minmax(160px, 40%) 1fr; }
    }
  `,
})
export class InboxScreen {
  protected readonly store = inject(InboxStore);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly auto = signal(true);
  protected readonly pane = signal<MailPane>('html');
  /** The pane on show: the HTML pane falls back to text for a message with no HTML part. */
  protected readonly shown = computed<MailPane>(() => (this.pane() === 'html' && !this.store.selected()?.html ? 'text' : this.pane()));
  protected readonly document = computed(() => this.sanitizer.bypassSecurityTrustHtml(htmlDocument(this.store.selected()?.html ?? '')));

  protected readonly name = senderName;
  protected readonly sender = senderLine;

  constructor() {
    const destroyed = inject(DestroyRef);
    void this.store.refresh().then(() => {
      const id = idFromHash(location.hash);
      if (id !== null && this.store.messages().some((message) => message.id === id)) void this.select(id);
    });

    effect((onCleanup) => {
      if (!this.auto()) return;
      const timer = setInterval(() => void this.store.refresh(), REFRESH_MS);
      onCleanup(() => clearInterval(timer));
    });
    destroyed.onDestroy(() => this.store.close());
  }

  protected select(id: number): Promise<void> {
    history.replaceState(null, '', `#${id}`);
    return this.store.open(id);
  }
}
