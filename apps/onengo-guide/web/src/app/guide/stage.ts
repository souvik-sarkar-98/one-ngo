import { Component, input } from '@angular/core';
import { isHighlighted, type LayoutName, type StageRow, type StageScreen } from './model';

const NAV = [
  { key: 'home', label: 'Home' },
  { key: 'records', label: 'Records' },
  { key: 'inbox', label: 'Inbox' },
  { key: 'more', label: 'More' },
];
const DEFAULT_COLUMNS = ['Name', 'Detail', 'Amount', 'Status'];

/** A picture of one product screen, in the guide's phone or browser frame. The yellow outline marks the control for this step. */
@Component({
  selector: 'guide-stage',
  template: `
    <div class="device" role="img" [attr.aria-label]="caption()" [class.device--web]="layout() === 'web'">
      @if (bar()) {
        <header class="bar">
          <strong>OneNGO</strong>
          <span class="org">{{ organisation() }}</span>
          <span class="sp"></span>
          <span class="bell" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 1 0-12 0v5l-2 2v1h16v-1z"/></svg>
            <span class="dot">4</span>
          </span>
          <span class="who">AS</span>
        </header>
      }
      <div class="device__body">
        @if (layout() === 'web' && productNav()) {
          <nav class="rail" aria-hidden="true">
            @for (item of nav; track item.key) {
              <span [class.on]="activeNav() === item.key" [class.hit]="hit('nav:' + item.key)">{{ item.label }}</span>
            }
          </nav>
        }
        <div class="canvas">
          @switch (screen().kind) {
            @case ('signin') {
              <section class="auth">
                <p class="brand">ONENGO</p>
                <span class="logo" aria-hidden="true"></span>
                <h2 [class.hit]="hit('heading')">{{ signin().heading }}</h2>
                <h3>Sign in</h3>
                <form class="card">
                  <div class="tabs">
                    <span class="on" [class.hit]="hit('chip:Password')">Password</span>
                    <span [class.hit]="hit('chip:Email code')">Email code</span>
                  </div>
                  <label [class.hit]="hit('field:Email')">Email<span></span></label>
                  <label [class.hit]="hit('field:Password')">Password<span></span></label>
                  <span class="btn primary wide" [class.hit]="signedIn()">Sign in</span>
                  <span class="link" [class.hit]="hit('action:Forgot password?')">Forgot password?</span>
                </form>
                <span class="link" [class.hit]="hit('action:Use another organisation')">Use another organisation</span>
              </section>
            }
            @case ('home') {
              <h2 class="screen-title" [class.hit]="hit('heading')">{{ home().greeting }}</h2>
              @for (group of home().groups; track group.name) {
                <section class="group">
                  <h3 class="sec-head">{{ group.name }}</h3>
                  <ul class="rows">
                    @for (type of group.types; track type) {
                      <li [class.hit]="hit('item:' + type)"><span>{{ type }}</span><span class="chev" aria-hidden="true">›</span></li>
                    }
                  </ul>
                </section>
              }
            }
            @case ('list') {
              <p class="crumbs">{{ list().crumbs.join(' › ') }}</p>
              <div class="pagehead">
                <h2>{{ list().title }}</h2>
                @if (list().fab && layout() === 'web') {
                  <span class="btn primary" [class.hit]="hit('fab')">New</span>
                }
              </div>
              <div class="chips">
                @for (chip of list().chips; track chip) {
                  <span [class.on]="chip === list().chip" [class.hit]="hit('chip:' + chip)">{{ chip }}</span>
                }
              </div>
              <p class="toolbar">
                <span class="search" [class.hit]="hit('search')">{{ list().search || 'Search' }}</span>
                <span class="tool" [class.hit]="hit('sort')">Sort</span>
                <span class="tool" [class.hit]="hit('filters')">Filters</span>
              </p>
              @if (list().pills.length) {
                <p class="pills">@for (pill of list().pills; track pill) { <span>{{ pill }}</span> }</p>
              }
              @if (list().bulk?.length) {
                <p class="bulk">@for (label of list().bulk ?? []; track label) { <span class="btn" [class.hit]="hit('action:' + label)">{{ label }}</span> }</p>
              }
              @if (layout() === 'mobile') {
                <ul class="cards">
                  @for (row of list().rows; track row.title) {
                    <li [class.hit]="hit('row')"><strong>{{ row.title }}</strong><span>{{ row.meta }}</span>@if (row.status) { <em>{{ row.status }}</em> }</li>
                  }
                </ul>
              } @else {
                <table>
                  <thead><tr>@for (column of columns(); track column) { <th>{{ column }}</th> }</tr></thead>
                  <tbody>
                    @for (row of list().rows; track row.title) {
                      <tr [class.hit]="hit('row')">@for (cell of cells(row); track $index) { <td>{{ cell }}</td> }</tr>
                    }
                  </tbody>
                </table>
              }
              @if (list().fab && layout() === 'mobile') {
                <span class="fab" [class.hit]="hit('fab')">+</span>
              }
            }
            @case ('panel') {
              <p class="crumbs">{{ panel().crumbs.join(' › ') }}</p>
              <div class="sheet" [class.sheet--web]="layout() === 'web'">
                <h2 [class.hit]="hit('heading')">{{ panel().heading }}</h2>
                @if (panel().sections?.length) {
                  @for (section of panel().sections ?? []; track section.label) {
                    <h3>{{ section.label }}</h3>
                    <dl>
                      @for (line of section.lines; track line.label) {
                        <div class="pair" [class.hit]="hit('field:' + line.label)"><dt>{{ line.label }}</dt><dd>{{ line.value }}</dd></div>
                      }
                    </dl>
                  }
                } @else {
                  <dl>
                    @for (line of panel().lines; track line.label) {
                      <div class="pair" [class.hit]="hit('field:' + line.label)"><dt>{{ line.label }}</dt><dd>{{ line.value }}</dd></div>
                    }
                  </dl>
                }
                @if (panel().confirm) {
                  <p class="note">{{ panel().confirm }}</p>
                }
                <p class="acts">
                  @for (action of panel().actions; track action) {
                    <span class="btn" [class.primary]="action === panel().primary" [class.hit]="hit('action:' + action)">{{ action }}</span>
                  }
                </p>
              </div>
            }
            @case ('inbox') {
              <h2>Inbox</h2>
              <div class="chips">
                <span [class.on]="inbox().tab === 'Approvals'" [class.hit]="hit('chip:Approvals')">Approvals {{ inbox().badge || '' }}</span>
                <span [class.on]="inbox().tab === 'Notifications'" [class.hit]="hit('chip:Notifications')">Notifications</span>
              </div>
              @if (layout() === 'mobile') {
                <ul class="cards">@for (row of inbox().rows; track row.title) { <li [class.hit]="hit('row')"><strong>{{ row.title }}</strong><span>{{ row.meta }}</span></li> }</ul>
              } @else {
                <table>
                  <thead><tr><th>Record</th><th>Waiting</th><th></th></tr></thead>
                  <tbody>@for (row of inbox().rows; track row.title) { <tr [class.hit]="hit('row')"><td>{{ row.title }}</td><td>{{ row.meta }}</td><td>{{ row.status || '' }}</td></tr> }</tbody>
                </table>
              }
            }
            @case ('more') {
              <section class="card"><strong>{{ more().account }}</strong><p>{{ more().detail }}</p></section>
              <ul class="cards">@for (item of more().items; track item) { <li [class.hit]="hit('item:' + item)">{{ item }}</li> }</ul>
            }
            @case ('builder') {
              @if (layout() === 'mobile') { <p class="note">Editing works best on a tablet or computer. You can review what is published here.</p> }
              <h2>{{ builder().title }}</h2>
              <p>{{ builder().body }}</p>
            }
            @case ('form') {
              <p class="crumbs">{{ form().crumbs.join(' › ') }}</p>
              <div class="split" [class.split--web]="layout() === 'web'">
                <form>
                  <h2>{{ form().title }}</h2>
                  @for (field of form().fields; track field.label) {
                    <label [class.hit]="hit('field:' + field.label)">{{ field.label }}<span>{{ field.value }}</span></label>
                  }
                </form>
                <aside>{{ form().aside }}</aside>
              </div>
            }
            @case ('lanes') {
              <h2>{{ lanes().title }}</h2>
              <div class="lanes" [class.lanes--web]="layout() === 'web'">
                @for (lane of lanes().lanes; track lane.name) {
                  <section><h3>{{ lane.name }}</h3>@for (item of lane.steps; track item) { <p>{{ item }}</p> }</section>
                }
              </div>
            }
            @case ('print') {
              <article class="paper"><h2>{{ print().title }}</h2>@for (line of print().lines; track line) { <p>{{ line }}</p> }</article>
            }
          }
        </div>
      </div>
      @if (layout() === 'mobile' && productNav()) {
        <nav class="dock" aria-hidden="true">
          @for (item of nav; track item.key) {
            <span [class.on]="activeNav() === item.key" [class.hit]="hit('nav:' + item.key)">{{ item.label }}</span>
          }
        </nav>
      }
    </div>
  `,
  styles: `
    .device { display: flex; flex-direction: column; width: min(100%, 360px); min-height: 420px; margin-inline: auto; border: 1px solid var(--line); border-radius: 16px; background: var(--bg); overflow: hidden; }
    .device--web { width: 100%; min-width: 640px; margin-inline: 0; }
    .bar, .dock, .rail span { display: flex; align-items: center; }
    .bar { gap: 10px; height: 56px; padding: 0 10px 0 12px; background: var(--brand); color: var(--brand-fg); }
    .bar strong { font-size: 1rem; }
    .org { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-inline-start: 10px; border-inline-start: 1px solid rgba(255,255,255,.35); font-size: .95rem; font-weight: 600; }
    .sp { flex: 1; }
    .bell { position: relative; width: 40px; height: 40px; display: grid; place-items: center; }
    .bell svg { width: 22px; height: 22px; fill: currentColor; }
    .dot { position: absolute; top: 4px; right: 2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: #fdf1dc; color: #9a6200; font-size: .6rem; font-weight: 700; line-height: 16px; text-align: center; }
    .who { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: rgba(255,255,255,.2); color: #fff; font-size: .75rem; font-weight: 700; }
    .device__body { display: flex; flex: 1; min-height: 0; }
    .rail { display: flex; flex-direction: column; gap: 8px; width: 84px; padding: 12px 0; border-right: 1px solid var(--line); background: var(--card); }
    .rail span, .dock span { justify-content: center; color: var(--muted); font-size: .68rem; }
    .rail span.on, .dock span.on { color: var(--brand); font-weight: 650; }
    .canvas { position: relative; flex: 1; min-width: 0; min-height: 420px; padding: 12px 16px 28px; background: var(--bg); }
    .dock { display: grid; grid-template-columns: repeat(4, 1fr); height: 52px; border-top: 1px solid var(--line); background: var(--card); }
    h2, h3 { margin: 0 0 8px; }
    .crumbs, .toolbar, .note { color: var(--muted); font-size: .8rem; }
    .card, .cards li, table, .sheet, .paper, .lanes section, form, aside, .rows { background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
    .auth { display: flex; flex-direction: column; align-items: center; width: min(420px, 100%); margin: 8px auto 0; text-align: center; }
    .brand { margin: 0; letter-spacing: .16em; text-transform: uppercase; font-size: .72rem; font-weight: 700; color: var(--brand); }
    .logo { width: 72px; height: 72px; margin: 8px 0 4px; border-radius: 22px; background: var(--card); border: 1px solid var(--line); box-shadow: 0 10px 28px rgba(28,36,48,.08); }
    .auth h2 { margin: 4px 0 0; font-size: 1.45rem; }
    .auth h3 { margin: 12px 0; font-size: 1.15rem; font-weight: 650; }
    .auth .card { width: 100%; padding: 16px; text-align: start; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: 0 0 12px; }
    .tabs span { flex: 1; padding: 4px 6px 10px; text-align: center; font-weight: 600; border-bottom: 2px solid transparent; }
    .tabs .on { border-bottom-color: var(--brand); color: var(--brand); }
    .link { display: block; margin-top: 10px; color: var(--brand); font-size: .9rem; text-align: center; }
    .wide { display: flex; justify-content: center; width: 100%; border-radius: 8px; min-height: 40px; }
    .group { margin: 0 0 12px; }
    .sec-head { margin: 0 0 7px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--brand) 8%, #fff); color: var(--brand); font-size: .68rem; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; }
    .rows { list-style: none; margin: 0; padding: 0; overflow: hidden; }
    .rows li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); font-size: .9rem; }
    .rows li:last-child { border-bottom: 0; }
    .chev { color: var(--muted); }
    .lanes { display: grid; gap: 8px; }
    .lanes--web, .split--web { grid-template-columns: 1fr 1fr; }
    .pagehead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .screen-title, .pagehead h2 { font-size: 1.35rem; }
    .card, .lanes section, aside, form { padding: 10px; }
    .chips, .pills, .acts, .bulk { display: flex; flex-wrap: wrap; gap: 6px; }
    .toolbar { display: flex; align-items: center; gap: 8px; }
    .search, .tool { min-height: 38px; display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
    .search { flex: 1; min-width: 0; padding: 0 10px; color: var(--muted); font-size: .8rem; }
    .tool { padding: 0 12px; font-size: .75rem; font-weight: 700; }
    .chips span, .pills span, .btn { border: 1px solid var(--line); border-radius: 999px; padding: 7px 13px; font-size: .75rem; font-weight: 700; }
    .chips .on { background: var(--brand); color: #fff; border-color: transparent; }
    .btn { background: var(--card); }
    .btn.primary { background: var(--brand); color: #fff; border-color: transparent; }
    .cards { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }
    .cards li { display: flex; flex-direction: column; gap: 2px; padding: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: .8rem; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); }
    .sheet { margin-top: 12px; padding: 12px; }
    .sheet--web { max-width: 420px; margin-inline: auto; }
    dl { display: grid; gap: 4px; margin: 0; }
    .pair { display: grid; grid-template-columns: 8rem 1fr; gap: 8px; padding: 2px; border-radius: 6px; }
    dt { color: var(--muted); }
    dd { margin: 0; }
    h3 { margin-top: 12px; font-size: .85rem; }
    label { display: block; margin: 8px 0; font-size: .8rem; color: var(--muted); }
    label span, aside { display: block; min-height: 36px; margin-top: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); }
    .split { display: grid; gap: 8px; }
    .paper { padding: 16px; }
    .fab { position: absolute; right: 16px; bottom: 16px; width: 44px; height: 44px; border-radius: 50%; background: var(--brand); color: #fff; display: grid; place-items: center; font-size: 24px; }
    .hit { outline: 3px solid #f3be26; outline-offset: 2px; border-radius: 8px; }
    tr.hit { outline-offset: -3px; }
  `,
})
export class Stage {
  readonly layout = input.required<LayoutName>();
  readonly screen = input.required<StageScreen>();
  /** The one control this step points at, or empty for none. */
  readonly highlight = input('');
  /** The name shown in the picture's header. */
  readonly organisation = input('Demo Foundation');
  readonly caption = input.required<string>();
  readonly nav = NAV;

  signin(): Extract<StageScreen, { kind: 'signin' }> { return this.as('signin'); }
  home(): Extract<StageScreen, { kind: 'home' }> { return this.as('home'); }
  list(): Extract<StageScreen, { kind: 'list' }> { return this.as('list'); }
  panel(): Extract<StageScreen, { kind: 'panel' }> { return this.as('panel'); }
  inbox(): Extract<StageScreen, { kind: 'inbox' }> { return this.as('inbox'); }
  more(): Extract<StageScreen, { kind: 'more' }> { return this.as('more'); }
  builder(): Extract<StageScreen, { kind: 'builder' }> { return this.as('builder'); }
  form(): Extract<StageScreen, { kind: 'form' }> { return this.as('form'); }
  lanes(): Extract<StageScreen, { kind: 'lanes' }> { return this.as('lanes'); }
  print(): Extract<StageScreen, { kind: 'print' }> { return this.as('print'); }

  hit(token: string): boolean {
    return isHighlighted(this.highlight(), token);
  }

  /** The sign-in step's button, whether the chapter names it Sign in or Continue. */
  signedIn(): boolean {
    return this.hit('action:Sign in') || this.hit('action:' + this.signin().action);
  }

  columns(): string[] {
    return this.list().columns ?? DEFAULT_COLUMNS;
  }

  cells(row: StageRow): string[] {
    return row.cells ?? [row.title, row.meta, row.amount || '—', row.status || '—'];
  }

  bar(): boolean {
    const kind = this.screen().kind;
    return kind !== 'signin' && kind !== 'print' && kind !== 'lanes';
  }

  productNav(): boolean {
    const kind = this.screen().kind;
    return kind !== 'signin' && kind !== 'print' && kind !== 'lanes' && kind !== 'builder';
  }

  activeNav(): string {
    const screen = this.screen();
    return 'nav' in screen ? screen.nav : '';
  }

  private as<Kind extends StageScreen['kind']>(kind: Kind): Extract<StageScreen, { kind: Kind }> {
    const screen = this.screen();
    if (screen.kind !== kind) throw new Error(`Expected ${kind}`);
    return screen as Extract<StageScreen, { kind: Kind }>;
  }
}
