import { Component, inject } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { MIGRATION_STEPS } from '../../core/admin/migration';
import { TranslatePipe } from '../../services/i18n';
import { ScreenHeading } from '../../ui/screen-heading';
import { MigrationStore } from './migration-store';

/**
 * One data migration, step by step: the CSV files of any columns, the record types each fills
 * (one row can fill several), the order they load in, the books, the check, and the run.
 */
@Component({
  selector: 'app-admin-migration',
  imports: [ScreenHeading, TranslatePipe, PageFrame],
  providers: [MigrationStore],
  styleUrls: ['../admin.css', './migration.css'],
  template: `
    <app-page-frame>
      @let s = store.snap();
      @let p = s.profile;
      <app-screen-heading [text]="p?.name ?? ('ui.crumbs.admin.migration' | t)" />
      @if (!store.allowed()) {
        <div class="notice error" role="alert">{{ 'ui.admin.migration.denied' | t }}</div>
      } @else if (!p) {
        @if (s.error) {
          <div class="notice error" role="alert">{{ s.error }}</div>
        } @else {
          <p class="muted" role="status">{{ 'ui.common.loading' | t }}</p>
        }
      } @else {
        <ul class="migration__steps">
          @for (step of steps; track step) {
            <li>
              <button type="button" class="migration__step" [class.migration__step--on]="store.step() === step" [attr.aria-current]="store.step() === step ? 'step' : null" (click)="store.goStep(step)">
                {{ 'ui.crumbs.migrationStep.' + step | t }}
              </button>
            </li>
          }
        </ul>
        @if (store.notice(); as n) {
          <div class="notice" [class.error]="n.level === 'error'" [class.ok]="n.level === 'success'" role="status">{{ n.message }}</div>
        }
        @if (s.error) {
          <div class="notice error" role="alert">
            {{ s.error }}
            @for (i of s.issues; track $index) {
              <div>{{ i.message }}</div>
            }
          </div>
        }
        @if (store.running() && store.step() !== 'run') {
          <div class="notice" role="status">{{ 'ui.admin.migration.isRunning' | t }} <button type="button" class="app-btn" (click)="store.goStep('run')">{{ 'ui.crumbs.migrationStep.run' | t }}</button></div>
        }

        @switch (store.step()) {
          @case ('files') {
            <p class="muted">{{ 'ui.admin.migration.filesIntro' | t }}</p>
            <label class="migration__field admin__card">
              <span>{{ 'ui.admin.migration.chooseFiles' | t }}</span>
              <input type="file" multiple accept=".csv,text/csv" [disabled]="s.busy || store.running()" (change)="store.addFiles($any($event.target).files); $any($event.target).value = ''" />
            </label>
            @if (p.sources.length) {
              <ul class="admin__list">
                @for (src of p.sources; track src.id) {
                  <li class="admin__row">
                    <span class="admin__label">
                      <strong>{{ src.fileName }}</strong>
                      <span class="muted">{{ 'ui.admin.migration.fileFacts' | t: { columns: src.columns.length, rows: src.rowCount } }}</span>
                    </span>
                    <span class="migration__badge" [attr.data-status]="src.mapping ? 'done' : ''">{{ (src.mapping ? 'ui.admin.migration.mapped' : 'ui.admin.migration.notMapped') | t }}</span>
                    <button type="button" class="app-btn" [disabled]="s.busy || store.running()" (click)="store.removeSource(src.id)">{{ 'ui.admin.migration.remove' | t }}</button>
                  </li>
                }
              </ul>
              <div class="migration__actions"><button type="button" class="app-btn app-btn--primary" (click)="store.goStep('map')">{{ 'ui.common.next' | t }}</button></div>
            }
          }

          @case ('map') {
            <p class="muted">{{ 'ui.admin.migration.mapIntro' | t }}</p>
            @if (!p.sources.length) {
              <p class="muted">{{ 'ui.admin.migration.noFiles' | t }}</p>
            } @else {
              <label class="migration__field">
                <span>{{ 'ui.admin.migration.file' | t }}</span>
                <select [value]="store.selected() ?? ''" (change)="store.pick($any($event.target).value)">
                  @for (src of p.sources; track src.id) {
                    <option [value]="src.id" [selected]="src.id === store.selected()">{{ src.fileName }}</option>
                  }
                </select>
              </label>
              @if (store.source(); as src) {
                @if (!store.types().length) {
                  <p class="muted">{{ 'ui.admin.migration.noTypes' | t }}</p>
                }
                @for (x of store.draft(); track x.key; let i = $index) {
                  <section class="migration__target">
                    <div class="admin__line">
                      <strong class="admin__grow">{{ store.typeOf(x.type)?.label ?? x.type }}</strong>
                      <button type="button" class="app-btn" (click)="store.removeTarget(i)">{{ 'ui.admin.migration.removeTarget' | t }}</button>
                    </div>
                    <div class="migration__grid">
                      <label class="migration__field">
                        <span>{{ 'ui.admin.migration.oldId' | t }}</span>
                        <select (change)="store.setOldId(i, $any($event.target).value)">
                          @for (c of store.columns(); track c) {
                            <option [value]="c" [selected]="c === x.oldId">{{ c }}</option>
                          }
                        </select>
                        <span class="muted">{{ 'ui.admin.migration.oldIdHint' | t }}</span>
                        @if (store.issue('/targets/' + i + '/oldId'); as e) {
                          <span class="migration__issue">{{ e }}</span>
                        }
                      </label>
                      <label class="migration__field">
                        <span><input type="checkbox" [checked]="x.required" (change)="store.setRequired(i, $any($event.target).checked)" /> {{ 'ui.admin.migration.required' | t }}</span>
                        <span class="muted">{{ 'ui.admin.migration.requiredHint' | t }}</span>
                      </label>
                    </div>
                    <div class="migration__grid">
                      @for (c of store.choices(x); track c.field.key) {
                        <label class="migration__field">
                          <span>{{ c.field.label }}@if (c.field.required) {<span aria-hidden="true"> *</span>}</span>
                          <select (change)="store.choose(i, c, $any($event.target).value)">
                            <option value="" [selected]="!c.value">{{ 'ui.admin.migration.notImported' | t }}</option>
                            @if (c.reference) {
                              @for (col of store.columns(); track col) {
                                <option [value]="'column:' + col" [selected]="c.value === 'column:' + col">{{ 'ui.admin.migration.byOldId' | t: { column: col } }}</option>
                              }
                              @for (e of store.earlier(i, c.field); track e.key) {
                                <option [value]="'target:' + e.key" [selected]="c.value === 'target:' + e.key">{{ 'ui.admin.migration.fromTarget' | t: { target: store.typeOf(e.type)?.label ?? e.key } }}</option>
                              }
                            } @else {
                              @for (col of src.columns; track col.name) {
                                <option [value]="col.name" [selected]="c.value === col.name">{{ store.columnLabel(col) }}</option>
                              }
                            }
                          </select>
                          @if (store.issue('/targets/' + i + '/fields/' + c.field.key) || store.issue('/targets/' + i + '/refs/' + c.field.key); as e) {
                            <span class="migration__issue">{{ e }}</span>
                          }
                        </label>
                      }
                    </div>
                  </section>
                }
                <div class="migration__actions">
                  <label class="migration__field">
                    <span>{{ 'ui.admin.migration.addTarget' | t }}</span>
                    <select (change)="store.addTarget($any($event.target).value); $any($event.target).value = ''">
                      <option value="">{{ 'ui.admin.migration.chooseType' | t }}</option>
                      @for (type of store.types(); track type.key) {
                        <option [value]="type.key">{{ type.label }}</option>
                      }
                    </select>
                  </label>
                </div>
                <div class="migration__actions">
                  <button type="button" class="app-btn app-btn--primary" [disabled]="s.busy || !store.draft().length || store.running()" (click)="store.saveMapping()">{{ 'ui.admin.migration.saveMapping' | t }}</button>
                  <button type="button" class="app-btn" (click)="store.goStep('order')">{{ 'ui.common.next' | t }}</button>
                </div>
              }
            }
          }

          @case ('order') {
            <p class="muted">{{ 'ui.admin.migration.orderIntro' | t }}</p>
            <ul class="admin__list">
              @for (src of p.sources; track src.id; let i = $index, first = $first, last = $last) {
                <li class="admin__row">
                  <span class="admin__label">
                    <strong>{{ i + 1 }} · {{ src.fileName }}</strong>
                    <span class="muted">{{ src.mapping ? store.typesOf(src.mapping.targets) : ('ui.admin.migration.leftOut' | t) }}</span>
                  </span>
                  <button type="button" class="app-btn" [disabled]="first || s.busy || store.running()" [attr.aria-label]="'ui.admin.migration.up' | t" (click)="store.move(src.id, -1)">↑</button>
                  <button type="button" class="app-btn" [disabled]="last || s.busy || store.running()" [attr.aria-label]="'ui.admin.migration.down' | t" (click)="store.move(src.id, 1)">↓</button>
                </li>
              }
            </ul>
            <div class="migration__actions"><button type="button" class="app-btn app-btn--primary" (click)="store.goStep('books')">{{ 'ui.common.next' | t }}</button></div>
          }

          @case ('books') {
            <p class="muted">{{ 'ui.admin.migration.booksIntro' | t }}</p>
            @if (p.booksAppliedAt) {
              <div class="notice ok" role="status">{{ 'ui.admin.migration.booksAppliedOn' | t: { date: p.booksAppliedAt.slice(0, 10) } }}</div>
            } @else if (!store.booksAllowed()) {
              <div class="notice" role="status">{{ 'ui.admin.migration.booksNoPermission' | t }}</div>
            } @else {
              @let b = store.books();
              <label class="migration__field admin__card">
                <span>{{ 'ui.admin.migration.cutover' | t }}</span>
                <input type="date" [value]="b.cutoverDate ?? ''" (change)="store.setCutover($any($event.target).value)" />
              </label>
              <h2 class="admin__caption">{{ 'ui.admin.migration.lines' | t }}</h2>
              @for (l of b.lines ?? []; track $index; let i = $index) {
                <div class="migration__grid">
                  <label class="migration__field"><span>{{ 'ui.admin.migration.account' | t }}</span><input type="text" [value]="l.accountCode" (input)="store.setLine(i, 'accountCode', $any($event.target).value)" /></label>
                  <label class="migration__field"><span>{{ 'ui.admin.migration.debit' | t }}</span><input type="text" inputmode="decimal" [value]="l.debit ?? ''" (input)="store.setLine(i, 'debit', $any($event.target).value)" /></label>
                  <label class="migration__field"><span>{{ 'ui.admin.migration.credit' | t }}</span><input type="text" inputmode="decimal" [value]="l.credit ?? ''" (input)="store.setLine(i, 'credit', $any($event.target).value)" /></label>
                  <button type="button" class="app-btn" (click)="store.removeLine(i)">{{ 'ui.admin.migration.remove' | t }}</button>
                </div>
              }
              <div class="migration__actions"><button type="button" class="app-btn" (click)="store.addLine()">{{ 'ui.admin.migration.addLine' | t }}</button></div>
              @if ((b.lines ?? []).length) {
                @let bal = store.balance();
                <p [class.migration__issue]="!bal.balanced" class="muted">{{ 'ui.admin.migration.balance' | t: { debit: bal.debit / 100, credit: bal.credit / 100 } }}</p>
              }
              <h2 class="admin__caption">{{ 'ui.admin.migration.receipts' | t }}</h2>
              @for (r of b.receipts ?? []; track $index; let i = $index) {
                <div class="migration__grid">
                  <label class="migration__field"><span>{{ 'ui.admin.migration.series' | t }}</span><input type="text" [value]="r.series" (input)="store.setReceipt(i, 'series', $any($event.target).value)" /></label>
                  <label class="migration__field"><span>{{ 'ui.admin.migration.next' | t }}</span><input type="number" min="1" step="1" [value]="r.next" (input)="store.setReceipt(i, 'next', $any($event.target).value)" /></label>
                  <button type="button" class="app-btn" (click)="store.removeReceipt(i)">{{ 'ui.admin.migration.remove' | t }}</button>
                </div>
              }
              <div class="migration__actions">
                <button type="button" class="app-btn" (click)="store.addReceipt()">{{ 'ui.admin.migration.addReceipt' | t }}</button>
                <button type="button" class="app-btn app-btn--primary" [disabled]="s.busy || store.running()" (click)="store.saveBooks()">{{ 'ui.admin.migration.saveBooks' | t }}</button>
              </div>
            }
            <div class="migration__actions"><button type="button" class="app-btn" (click)="store.goStep('check')">{{ 'ui.common.next' | t }}</button></div>
          }

          @case ('check') {
            <p class="muted">{{ 'ui.admin.migration.checkIntro' | t }}</p>
            @if (p.check; as c) {
              <div class="migration__counts">
                <div><b>{{ c.rows }}</b>{{ 'ui.admin.migration.rows' | t }}</div>
                <div><b>{{ c.ready }}</b>{{ 'ui.admin.migration.ready' | t }}</div>
                <div><b>{{ c.invalid }}</b>{{ 'ui.admin.migration.problems' | t }}</div>
                <div><b>{{ c.creates }}</b>{{ 'ui.admin.migration.willCreate' | t }}</div>
                <div><b>{{ c.updates }}</b>{{ 'ui.admin.migration.willUpdate' | t }}</div>
              </div>
              <ul class="admin__list">
                @for (x of c.sources; track x.sourceId) {
                  <li class="admin__row">
                    <span class="admin__label">
                      <strong>{{ x.fileName }}</strong>
                      <span class="muted">{{ 'ui.admin.migration.sourceCheck' | t: { ready: x.ready, invalid: x.invalid, creates: x.creates, updates: x.updates } }}</span>
                    </span>
                    <span class="migration__badge" [attr.data-status]="x.invalid ? 'problems' : 'ready'">{{ (x.invalid ? 'ui.admin.migration.problems' : 'ui.admin.migration.ready') | t }}</span>
                  </li>
                }
              </ul>
              @for (x of c.problems; track $index) {
                <div class="admin__problem">{{ 'ui.admin.migration.problem' | t: { file: x.fileName, row: x.row, message: x.message } }}</div>
              }
              @if (c.invalid > c.problems.length) {
                <p class="muted">{{ 'ui.admin.migration.moreProblems' | t: { shown: c.problems.length } }}</p>
              }
            } @else {
              <p class="muted">{{ 'ui.admin.migration.notChecked' | t }}</p>
            }
            <div class="migration__actions">
              <button type="button" class="app-btn" [disabled]="s.busy || store.running()" (click)="store.check()">{{ (p.check ? 'ui.admin.migration.checkAgain' : 'ui.admin.migration.checkNow') | t }}</button>
              @if (p.status === 'checked' && p.check) {
                <button type="button" class="app-btn app-btn--primary" [disabled]="s.busy || !p.check.ready" (click)="store.run()">{{ 'ui.admin.migration.run' | t: { count: p.check.ready } }}</button>
              }
            </div>
          }

          @case ('run') {
            @if (p.status === 'running') {
              <p class="muted">{{ 'ui.admin.migration.runIntro' | t }}</p>
              @let job = s.job;
              <p><strong>{{ 'ui.admin.migration.progress' | t: { done: job?.progress ?? 0, total: job?.total ?? 0 } }}</strong></p>
              <div class="admin__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="store.percent()"><i [style.width.%]="store.percent()"></i></div>
              <div class="migration__actions"><button type="button" class="app-btn" [disabled]="s.busy || !!job?.cancelRequested" (click)="store.cancel()">{{ 'ui.admin.migration.cancel' | t }}</button></div>
            } @else if (p.status === 'done') {
              <div class="notice ok" role="status">{{ 'ui.admin.migration.finished' | t }}</div>
            } @else if (p.status === 'failed') {
              <div class="notice error" role="status">{{ 'ui.admin.migration.stopped' | t }}</div>
            } @else {
              <p class="muted">{{ 'ui.admin.migration.notRun' | t }}</p>
            }
            @if (p.jobId) {
              <ul class="admin__list">
                @for (src of p.sources; track src.id) {
                  @if (src.counts; as k) {
                    <li class="admin__row">
                      <span class="admin__label">
                        <strong>{{ src.fileName }}</strong>
                        <span class="muted">{{ 'ui.admin.migration.sourceResult' | t: { created: k.created, updated: k.updated, failed: k.failed } }}</span>
                      </span>
                      @if (k.failed && p.status !== 'running') {
                        <button type="button" class="app-btn" (click)="store.downloadFailed(src.id)">{{ 'ui.admin.migration.downloadFailed' | t }}</button>
                      }
                    </li>
                  }
                }
              </ul>
            }
            @if (p.booksResult?.error) {
              <div class="notice error" role="alert">{{ 'ui.admin.migration.booksError' | t: { error: p.booksResult?.error ?? '' } }}</div>
              @if (store.booksAllowed() && p.status === 'done' && !p.booksAppliedAt) {
                <div class="migration__actions"><button type="button" class="app-btn app-btn--primary" [disabled]="s.busy" (click)="store.applyBooks()">{{ 'ui.admin.migration.applyBooks' | t }}</button></div>
              }
            } @else if (p.booksAppliedAt) {
              <div class="notice ok" role="status">{{ 'ui.admin.migration.booksAppliedOn' | t: { date: p.booksAppliedAt.slice(0, 10) } }}</div>
            }
          }
        }
      }
    </app-page-frame>
  `,
})
export class MigrationScreen {
  readonly store = inject(MigrationStore);
  readonly steps = MIGRATION_STEPS;
}
