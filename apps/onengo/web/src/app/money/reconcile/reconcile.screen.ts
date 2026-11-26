import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Btn, Icon, PageFrame } from '@onengo/web-kit';
import { COLUMN_ROLES, DATE_ORDERS } from '../../core/money/statement-import';
import { TranslatePipe } from '../../services/i18n';
import { ScreenHeading } from '../../ui/screen-heading';
import { ReconcileStore, type Step } from './reconcile-store';

/** Reconcile one money account with the bank's statement (`/accounts/:key/reconcile`). */
@Component({
  selector: 'app-reconcile',
  imports: [PageFrame, ScreenHeading, TranslatePipe, Btn, Icon],
  providers: [ReconcileStore],
  styleUrls: ['../../admin/admin.css', './reconcile.css'],
  template: `
    <app-page-frame>
      <div class="admin__line admin__line--title">
        <app-screen-heading class="admin__grow" [text]="('ui.money.reconcile.title' | t) + ': ' + store.accountName()" />
      </div>
      <div class="recon__summary">
        <span>{{ store.subtitle() }}</span>
        <span class="badge" [class.warn]="store.counts().unmatched" [class.ok]="!store.counts().unmatched && store.lines().length">{{ 'ui.money.reconcile.tab.unmatched' | t }} {{ store.counts().unmatched }}</span>
        <span class="badge">{{ 'ui.money.reconcile.tab.matched' | t }} {{ store.counts().matched }}</span>
        <span class="badge">{{ 'ui.money.reconcile.tab.ignored' | t }} {{ store.counts().ignored }}</span>
      </div>

      <ol class="recon__steps" [attr.aria-label]="'ui.money.reconcile.steps' | t">
        @for (s of steps; track s.key; let i = $index) {
          <li [class.recon__done]="i < stepIndex()">
            <button type="button" class="recon__step" [class.recon__step--on]="store.step() === s.key" [attr.aria-current]="store.step() === s.key ? 'step' : null" [attr.data-testid]="'recon-step-' + s.key" [disabled]="!store.enabled().has(s.key)" (click)="store.goTo(s.key)">
              <span class="recon__dot">
                @if (i < stepIndex()) {
                  <app-icon name="check" />
                } @else {
                  {{ i + 1 }}
                }
              </span>
              <span>{{ s.label | t }}</span>
            </button>
          </li>
        }
      </ol>

      @if (store.error(); as err) {
        <p class="notice error" role="alert" data-testid="recon-error">{{ err }}</p>
      }
      @if (store.message(); as msg) {
        <p class="notice ok" role="status" data-testid="recon-message">{{ msg }}</p>
      }

      <section class="recon__page" [attr.aria-busy]="store.loading() || store.busy()">
      <header class="recon__head">
        <span class="recon__eyebrow">{{ 'ui.admin.migration.stepOf' | t: { n: stepIndex() + 1, total: steps.length } }}</span>
        <h2>{{ 'ui.money.reconcile.step.' + store.step() | t }}</h2>
        @if (intro(); as key) {
          <p>{{ key | t }}</p>
        }
      </header>
      @switch (store.step()) {
        @case ('import') {
          <section class="recon__section" data-testid="recon-import">
            @if (store.importText(); as text) {
              <p class="notice ok" role="status" data-testid="recon-imported">
                {{ text }}
                <button appBtn="" type="button" data-testid="recon-to-review" (click)="store.goTo('review')">{{ 'ui.money.reconcile.toReview' | t }}</button>
              </p>
            }
            <label class="recon__drop" [class.recon__drop--over]="over()" (dragover)="$event.preventDefault(); over.set(true)" (dragleave)="over.set(false)" (drop)="drop($event)">
              <span class="recon__icon"><app-icon name="upload" /></span>
              <strong>{{ (store.file() ? 'ui.money.reconcile.chooseOther' : 'ui.money.reconcile.chooseFile') | t }}</strong>
              <span>{{ 'ui.money.reconcile.dropHint' | t }}</span>
              <input type="file" accept=".csv,text/csv,text/plain" data-testid="recon-file" (change)="store.chooseFile($any($event.target).files?.[0]); $any($event.target).value = ''" />
            </label>

            @if (store.file(); as f) {
              <div class="recon__file">
                <span class="recon__icon" data-status="done"><app-icon name="file" /></span>
                <span class="recon__file-name" data-testid="recon-file-name">{{ f.name }} · {{ store.dataRows().length }} {{ 'ui.money.reconcile.rows' | t }}</span>
              </div>
              <div class="recon__split">
                <div class="recon__card">
                  <h3>{{ 'ui.money.reconcile.matchColumns' | t }}</h3>
                  <table class="recon__table">
                    <thead>
                      <tr>
                        <th>{{ 'ui.money.reconcile.yourColumn' | t }}</th>
                        <th>{{ 'ui.money.reconcile.means' | t }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (h of store.headers(); track $index) {
                        <tr>
                          <td>
                            <code>{{ h }}</code>
                          </td>
                          <td>
                            <select [attr.aria-label]="h" [attr.data-testid]="'recon-role-' + $index" [value]="store.setup().roles[h]" (change)="store.setRole(h, $any($event.target).value)">
                              @for (r of roles; track r) {
                                <option [value]="r" [selected]="store.setup().roles[h] === r">{{ 'ui.money.reconcile.role.' + r | t }}</option>
                              }
                            </select>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                <div class="recon__card">
                  <h3>{{ 'ui.money.reconcile.format' | t }}</h3>
                  <label class="recon__field">
                    <span>{{ 'ui.money.reconcile.dateFormat' | t }}</span>
                    <select data-testid="recon-date-order" (change)="store.setDateOrder($any($event.target).value)">
                      @for (o of orders; track o) {
                        <option [value]="o" [selected]="store.setup().dateOrder === o">{{ 'ui.money.reconcile.dateOrder.' + o | t }}</option>
                      }
                    </select>
                  </label>
                  <label class="recon__radio">
                    <input type="radio" name="amountStyle" value="single" [checked]="store.setup().amountStyle === 'single'" (change)="store.setAmountStyle('single')" />
                    {{ 'ui.money.reconcile.amountSingle' | t }}
                  </label>
                  <label class="recon__radio">
                    <input type="radio" name="amountStyle" value="split" data-testid="recon-split" [checked]="store.setup().amountStyle === 'split'" (change)="store.setAmountStyle('split')" />
                    {{ 'ui.money.reconcile.amountSplit' | t }}
                  </label>
                  <label class="recon__radio">
                    <input type="checkbox" [checked]="store.remember()" (change)="store.remember.set($any($event.target).checked)" />
                    {{ 'ui.money.reconcile.remember' | t }}
                  </label>
                  <p class="muted">{{ 'ui.money.reconcile.rememberHint' | t }}</p>
                </div>
              </div>

              @if (store.setupIssue(); as issue) {
                <p class="notice error" role="alert" data-testid="recon-setup-issue">{{ issue }}</p>
              } @else {
                <div class="recon__card">
                  <h3>{{ 'ui.money.reconcile.preview' | t }}</h3>
                  <div class="recon__scroll">
                    <table class="recon__table" data-testid="recon-preview">
                      <thead>
                        <tr>
                          <th>{{ 'ui.money.csv.date' | t }}</th>
                          <th>{{ 'ui.money.csv.details' | t }}</th>
                          <th>{{ 'ui.money.csv.reference' | t }}</th>
                          <th class="recon__num">{{ 'ui.money.reconcile.amount' | t }}</th>
                          <th>{{ 'ui.money.reconcile.check' | t }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (r of store.preview(); track r.row) {
                          <tr [class.recon__bad]="r.problem">
                            <td>{{ r.line?.date ?? r.raw.date }}</td>
                            <td>{{ r.raw.description }}</td>
                            <td>{{ r.raw.reference }}</td>
                            <td class="recon__num">{{ r.line?.amount ?? r.raw.amount }}</td>
                            <td>{{ r.problem ? ('ui.money.reconcile.problem.' + r.problem | t) : ('ui.money.reconcile.ok' | t) }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                  @if (store.problemRows().length) {
                    <p class="notice warn" data-testid="recon-problems">
                      {{ 'ui.money.reconcile.leftOut' | t: { count: store.problemRows().length } }}
                      @for (r of store.problemRows().slice(0, 5); track r.row) {
                        <small class="recon__problem">{{ 'ui.money.reconcile.rowNumber' | t: { row: r.row } }}: {{ 'ui.money.reconcile.problem.' + r.problem | t }} ({{ r.raw.date || r.raw.amount }})</small>
                      }
                    </p>
                  }
                </div>
                <div class="recon__buttons">
                  <button appBtn="" type="button" (click)="store.cancelFile()">{{ 'ui.common.cancel' | t }}</button>
                  <button appBtn="primary" type="button" data-testid="recon-import-go" [disabled]="!store.usable().length || store.busy()" (click)="store.importNow()">
                    {{ 'ui.money.reconcile.importLines' | t: { count: store.usable().length } }}
                  </button>
                </div>
              }
            }
          </section>
        }

        @case ('review') {
          <section class="recon__section" data-testid="recon-review">
            <div class="recon__tabs" role="tablist">
              @for (tab of tabs; track tab) {
                <button type="button" role="tab" class="recon__tab" [class.recon__tab--on]="store.tab() === tab" [attr.aria-selected]="store.tab() === tab" [attr.data-testid]="'recon-tab-' + tab" (click)="store.setTab(tab)">
                  {{ 'ui.money.reconcile.tab.' + tab | t }} <em>{{ store.counts()[tab] }}</em>
                </button>
              }
              <span class="admin__grow"></span>
              @if (store.counts().unmatched) {
                <button appBtn="" type="button" data-testid="recon-auto" [disabled]="store.busy()" (click)="store.autoMatch()">{{ 'ui.money.reconcile.autoMatch' | t }}</button>
              }
            </div>

            <div class="recon__scroll">
              <table class="recon__table" data-testid="recon-lines">
                <thead>
                  <tr>
                    <th>{{ 'ui.money.csv.date' | t }}</th>
                    <th>{{ 'ui.money.csv.details' | t }}</th>
                    <th class="recon__num">{{ 'ui.money.reconcile.amount' | t }}</th>
                    <th>{{ 'ui.money.reconcile.do' | t }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of store.rows(); track r.id) {
                    <tr data-testid="recon-line">
                      <td>{{ r.date }}</td>
                      <td>
                        {{ r.description }}
                        @if (r.reference) {
                          <small class="recon__ref">{{ r.reference }}</small>
                        }
                        @if (r.note) {
                          <small class="recon__ref">{{ r.note }}</small>
                        }
                      </td>
                      <td class="recon__num" [class.recon__in]="r.moneyIn" [class.recon__out]="!r.moneyIn">{{ r.amount }}</td>
                      <td>
                        <div class="recon__buttons recon__buttons--row">
                          @if (r.status === 'unmatched') {
                            <button [appBtn]="r.likely === 'match' ? 'primary' : ''" type="button" data-testid="recon-match" [disabled]="store.busy()" (click)="store.openPanel(r.id, 'match')">{{ 'ui.money.reconcile.match' | t }}</button>
                            <button [appBtn]="r.likely === 'book' ? 'primary' : ''" type="button" data-testid="recon-book" [disabled]="store.busy()" (click)="store.openPanel(r.id, 'book')">{{ 'ui.money.reconcile.book' | t }}</button>
                            <button appBtn="" type="button" data-testid="recon-ignore" [disabled]="store.busy()" (click)="store.openPanel(r.id, 'ignore')">{{ 'ui.money.reconcile.ignore' | t }}</button>
                          } @else {
                            <button appBtn="" type="button" data-testid="recon-reopen" [disabled]="store.busy()" (click)="store.reopen(r.id)">{{ 'ui.money.reconcile.reopen' | t }}</button>
                          }
                        </div>
                      </td>
                    </tr>
                    @if (store.open(); as o) {
                      @if (o.id === r.id) {
                        <tr class="recon__panel-row">
                          <td colspan="4">
                            <div class="recon__panel" [attr.data-testid]="'recon-panel-' + o.action">
                              <h3>{{ 'ui.money.reconcile.panel.' + o.action | t }}</h3>
                              @switch (o.action) {
                                @case ('match') {
                                  @if (store.candidates().length) {
                                    @for (c of store.candidates(); track c.id) {
                                      <label class="recon__radio">
                                        <input type="radio" name="pick" [value]="c.id" [checked]="store.pick() === c.id" (change)="store.pick.set(c.id)" />
                                        <span>{{ c.label }}</span> <b>{{ c.amount }}</b>
                                      </label>
                                    }
                                    <p class="muted">{{ 'ui.money.reconcile.matchHint' | t }}</p>
                                  } @else {
                                    <p class="muted" data-testid="recon-no-entries">{{ 'ui.money.reconcile.noEntries' | t }}</p>
                                  }
                                }
                                @case ('book') {
                                  <label class="recon__field">
                                    <span>{{ 'ui.money.reconcile.otherSide' | t }}</span>
                                    <select data-testid="recon-other-side" [value]="store.otherSide()" (change)="store.otherSide.set($any($event.target).value)">
                                      <option value="">{{ 'ui.money.reconcile.choose' | t }}</option>
                                      @for (a of store.otherSides(); track a.code) {
                                        <option [value]="a.code" [selected]="store.otherSide() === a.code">{{ a.label }}</option>
                                      }
                                    </select>
                                  </label>
                                  <label class="recon__field">
                                    <span>{{ 'ui.money.reconcile.memo' | t }}</span>
                                    <input type="text" maxlength="200" data-testid="recon-memo" [value]="store.memo()" (input)="store.memo.set($any($event.target).value)" />
                                  </label>
                                  <p class="muted">{{ 'ui.money.reconcile.bookHint' | t }}</p>
                                }
                                @case ('ignore') {
                                  <label class="recon__field">
                                    <span>{{ 'ui.money.reconcile.whyIgnored' | t }}</span>
                                    <input type="text" maxlength="500" data-testid="recon-note" [value]="store.note()" (input)="store.note.set($any($event.target).value)" />
                                  </label>
                                  <p class="muted">{{ 'ui.money.reconcile.ignoreHint' | t }}</p>
                                }
                              }
                              @if (store.panelError(); as pe) {
                                <p class="notice error" role="alert">{{ pe }}</p>
                              }
                              <div class="recon__buttons">
                                <button appBtn="" type="button" (click)="store.closePanel()">{{ 'ui.common.cancel' | t }}</button>
                                <button appBtn="primary" type="button" data-testid="recon-confirm" [disabled]="store.busy() || (o.action === 'match' && !store.candidates().length)" (click)="store.confirm()">
                                  {{ 'ui.money.reconcile.' + o.action | t }}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      }
                    }
                  } @empty {
                    <tr>
                      <td colspan="4" class="recon__empty-cell">
                        <div class="recon__empty">
                          <span class="recon__icon"><app-icon name="check" /></span>
                          <span>{{ 'ui.money.reconcile.empty.' + store.tab() | t }}</span>
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (store.tab() === 'unmatched') {
              <p class="muted">{{ 'ui.money.reconcile.likelyHint' | t }}</p>
            }
            <div class="recon__buttons recon__buttons--between recon__nav">
              <button appBtn="" type="button" class="recon__btn-icon" (click)="store.goTo('import')"><app-icon name="back" />{{ 'ui.money.reconcile.backToImport' | t }}</button>
              <button appBtn="primary" type="button" class="recon__btn-icon" data-testid="recon-next" [disabled]="!store.enabled().has('reconcile')" (click)="store.goTo('reconcile')">{{ 'ui.money.reconcile.nextReconcile' | t }}<app-icon name="forward" /></button>
            </div>
          </section>
        }

        @case ('reconcile') {
          <section class="recon__section" data-testid="recon-compare">
            <form class="recon__figures" (submit)="$event.preventDefault(); store.compare()">
              <label class="recon__field">
                <span>{{ 'ui.money.reconcile.asOn' | t }}</span>
                <input type="date" data-testid="recon-as-on" [value]="store.asOf()" (input)="store.asOf.set($any($event.target).value)" />
              </label>
              <label class="recon__field">
                <span>{{ 'ui.money.reconcile.closingBalance' | t }}</span>
                <input type="text" inputmode="decimal" data-testid="recon-balance" [value]="store.balance()" (input)="store.balance.set($any($event.target).value)" />
              </label>
              <button appBtn="primary" type="submit" data-testid="recon-compare-go" [disabled]="store.busy()">{{ 'ui.money.reconcile.compare' | t }}</button>
            </form>
            @if (store.figuresError(); as fe) {
              <p class="notice error" role="alert">{{ fe }}</p>
            }

            @if (store.report(); as r) {
              <div class="recon__card" data-testid="recon-report">
                <h3>{{ 'ui.money.reconcile.howCompare' | t }}</h3>
                <dl class="recon__eq">
                  @for (row of store.comparison(); track row.key) {
                    <dt [class.recon__sum]="row.key === 'difference'">
                      {{ row.label }}
                      @if (row.detail) {
                        <small class="recon__ref">{{ row.detail }}</small>
                      }
                    </dt>
                    <dd [class.recon__sum]="row.key === 'difference'" [attr.data-testid]="'recon-' + row.key">{{ row.value }}</dd>
                  }
                </dl>
                @if (store.blocker(); as why) {
                  <p class="notice warn" data-testid="recon-blocker">{{ why }}</p>
                } @else {
                  <p class="notice ok" data-testid="recon-reconciled">{{ 'ui.money.reconcile.reconciled' | t }}</p>
                }
              </div>
              <label class="recon__field">
                <span>{{ 'ui.money.reconcile.signNote' | t }}</span>
                <input type="text" maxlength="500" data-testid="recon-sign-note" [value]="store.signNote()" (input)="store.signNote.set($any($event.target).value)" />
              </label>
              <p class="muted">{{ 'ui.money.reconcile.signLimit' | t }}</p>
            }
            <div class="recon__buttons recon__buttons--between recon__nav">
              <button appBtn="" type="button" class="recon__btn-icon" (click)="store.goTo('review')"><app-icon name="back" />{{ 'ui.common.back' | t }}</button>
              <button appBtn="primary" type="button" data-testid="recon-sign" [disabled]="!store.report() || !!store.blocker() || store.busy()" (click)="store.signOff()">{{ 'ui.money.reconcile.signOff' | t }}</button>
            </div>

            @if (store.pastSignOffs().length) {
              <div class="recon__card">
                <h3>{{ 'ui.money.reconcile.past' | t }}</h3>
                <div class="recon__scroll">
                  <table class="recon__table" data-testid="recon-past">
                    <thead>
                      <tr>
                        <th>{{ 'ui.money.reconcile.asOn' | t }}</th>
                        <th class="recon__num">{{ 'ui.money.reconcile.statementBalance' | t }}</th>
                        <th class="recon__num">{{ 'ui.money.reconcile.booksBalance' | t }}</th>
                        <th class="recon__num">{{ 'ui.money.reconcile.outstandingShort' | t }}</th>
                        <th>{{ 'ui.money.reconcile.signedOn' | t }}</th>
                        <th>{{ 'ui.money.reconcile.note' | t }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (s of store.pastSignOffs(); track s.id) {
                        <tr>
                          <td>{{ s.asOf }}</td>
                          <td class="recon__num">{{ s.statement }}</td>
                          <td class="recon__num">{{ s.books }}</td>
                          <td class="recon__num">{{ s.outstanding }}</td>
                          <td>{{ s.signedOn }}</td>
                          <td>{{ s.note }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            }
          </section>
        }
      }
      </section>
    </app-page-frame>
  `,
})
export class ReconcileScreen {
  readonly store = inject(ReconcileStore);
  /** The account's key, from the address. */
  readonly key = input.required<string>();

  readonly steps: { key: Step; label: string }[] = [
    { key: 'import', label: 'ui.money.reconcile.step.import' },
    { key: 'review', label: 'ui.money.reconcile.step.review' },
    { key: 'reconcile', label: 'ui.money.reconcile.step.reconcile' },
  ];
  readonly tabs = ['unmatched', 'matched', 'ignored'] as const;
  readonly roles = COLUMN_ROLES;
  readonly orders = DATE_ORDERS;

  /** A file is being dragged over the drop area. */
  readonly over = signal(false);
  /** Where the current step sits in `steps`. */
  readonly stepIndex = computed(() => this.steps.findIndex((s) => s.key === this.store.step()));
  /** The catalogue key of the line that explains the current step, if it has one. */
  readonly intro = computed(() => ({ import: 'ui.money.reconcile.importHint', review: '', reconcile: 'ui.money.reconcile.compareHint' })[this.store.step()]);

  constructor() {
    effect(() => this.store.key.set(this.key()));
  }

  /** A statement dropped on the drop area is read like one chosen with the button. */
  drop(e: DragEvent): void {
    e.preventDefault();
    this.over.set(false);
    void this.store.chooseFile(e.dataTransfer?.files?.[0]);
  }
}