import { Component, inject, signal } from '@angular/core';
import { Btn, Icon, PageFrame } from '@onengo/web-kit';
import { MIGRATION_STEPS, ROLE_SEPARATORS, type MigrationStep, type ProfileStatus } from '../../core/admin/migration';
import { TranslatePipe } from '../../services/i18n';
import { DialogFocus } from '../../ui/dialog';
import { ScreenHeading } from '../../ui/screen-heading';
import { droppedFiles, pickedFiles } from './attachment-files';
import { MigrationStore } from './migration-store';

/**
 * One data migration, step by step: the CSV files of any columns, the record types each fills
 * (one row can fill several), the order they load in, the books, the check, and the run.
 */
@Component({
  selector: 'app-admin-migration',
  imports: [Btn, Icon, ScreenHeading, TranslatePipe, PageFrame, DialogFocus],
  providers: [MigrationStore],
  styleUrls: ['../admin.css', './migration.css', './migration-steps.css', './migration-files.css'],
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
        @let off = s.busy || store.running() || store.finished() || store.checking();
        <div class="migration__summary">
          <span [class]="'badge ' + tone(p.status)">{{ 'ui.admin.migration.status.' + p.status | t }}</span>
          <span>{{ 'ui.admin.migration.fileCount' | t: { count: p.sources.length } }}</span>
          <span>{{ 'ui.admin.migration.updatedOn' | t: { date: p.updatedAt.slice(0, 10) } }}</span>
        </div>
        <ol class="migration__steps">
          @for (step of steps; track step; let i = $index) {
            <li [class.migration__done]="store.done().has(step)">
              <button type="button" class="migration__step" [class.migration__step--on]="store.step() === step" [attr.aria-current]="store.step() === step ? 'step' : null" [disabled]="!store.enabled().has(step)" (click)="store.goStep(step)">
                <span class="migration__dot">
                  @if (store.done().has(step) && store.step() !== step) {
                    <app-icon name="check" />
                  } @else {
                    {{ i + 1 }}
                  }
                </span>
                <span>{{ 'ui.crumbs.migrationStep.' + step | t }}</span>
              </button>
            </li>
          }
        </ol>
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
          <div class="notice info migration__new" role="status">
            <span class="admin__grow">{{ 'ui.admin.migration.isRunning' | t }}</span>
            <button appBtn size="sm" type="button" (click)="store.goStep('run')">{{ 'ui.crumbs.migrationStep.run' | t }}</button>
          </div>
        }

        <section class="migration__card">
          <header class="migration__head">
            <span class="migration__eyebrow">{{ 'ui.admin.migration.stepOf' | t: { n: steps.indexOf(store.step()) + 1, total: steps.length } }}</span>
            <h2>{{ 'ui.crumbs.migrationStep.' + store.step() | t }}</h2>
            @if (store.step() !== 'run' || p.status === 'running') {
              <p>{{ intro(store.step()) | t }}</p>
            }
          </header>
          <fieldset class="migration__body" [disabled]="store.finished() || store.checking()">

          @switch (store.step()) {
            @case ('files') {
              <label
                class="migration__drop"
                [class.migration__drop--over]="over()"
                [class.migration__drop--off]="off"
                (dragover)="$event.preventDefault(); over.set(!off)"
                (dragleave)="over.set(false)"
                (drop)="drop($event, off)"
              >
                <span class="migration__icon"><app-icon name="upload" /></span>
                <strong>{{ 'ui.admin.migration.chooseFiles' | t }}</strong>
                <span>{{ 'ui.admin.migration.dropHint' | t }}</span>
                <input type="file" multiple accept=".csv,text/csv" [disabled]="off" (change)="store.addFiles($any($event.target).files); $any($event.target).value = ''" />
              </label>
              @if (p.sources.length) {
                <ul class="admin__list migration__list">
                  @for (src of p.sources; track src.id) {
                    <li class="admin__row">
                      <span class="migration__icon" [attr.data-status]="src.mapping ? 'done' : null"><app-icon name="file" /></span>
                      <span class="admin__label">
                        <strong>{{ src.fileName }}</strong>
                        <span class="muted">{{ 'ui.admin.migration.fileFacts' | t: { columns: src.columns.length, rows: src.rowCount } }}</span>
                      </span>
                      @if (src.purgedAt) {
                        <span class="badge warn">{{ 'ui.admin.migration.sourceDeleted' | t }}</span>
                      }
                      <span [class]="'badge ' + (src.mapping ? 'ok' : 'warn')">{{ (src.mapping ? 'ui.admin.migration.mapped' : 'ui.admin.migration.notMapped') | t }}</span>
                      <button appBtn="danger" size="sm" type="button" class="migration__icon-btn" [disabled]="off" [attr.aria-label]="'ui.admin.migration.remove' | t" [title]="'ui.admin.migration.remove' | t" (click)="store.removeSource(src.id)"><app-icon name="delete" /></button>
                    </li>
                  }
                </ul>
              }
              <h3 class="migration__section">{{ 'ui.admin.migration.attach.title' | t }} <span class="badge">{{ 'ui.admin.migration.attach.optional' | t }}</span></h3>
              @if (store.purged()) {
                <div class="notice warn" role="status">{{ 'ui.admin.migration.attach.deleted' | t }}</div>
              }
              <p class="migration__hint">{{ 'ui.admin.migration.attach.intro' | t }}</p>
              <div
                class="migration__drop migration__drop--files"
                [class.migration__drop--over]="overFiles()"
                [class.migration__drop--off]="off"
                (dragover)="$event.preventDefault(); overFiles.set(!off)"
                (dragleave)="overFiles.set(false)"
                (drop)="dropAttachments($event, off)"
              >
                <strong>{{ 'ui.admin.migration.attach.dropTitle' | t }}</strong>
                <span>{{ 'ui.admin.migration.attach.dropHint' | t }}</span>
                <div class="migration__actions">
                  <button appBtn size="sm" type="button" [disabled]="off" (click)="folder.click()">{{ 'ui.admin.migration.attach.chooseFolder' | t }}</button>
                  <button appBtn size="sm" type="button" [disabled]="off" (click)="many.click()">{{ 'ui.admin.migration.attach.chooseFiles' | t }}</button>
                </div>
                <input #folder type="file" hidden webkitdirectory [disabled]="off" [attr.aria-label]="'ui.admin.migration.attach.chooseFolder' | t" (change)="pickAttachments($any($event.target))" />
                <input #many type="file" hidden multiple [disabled]="off" [attr.aria-label]="'ui.admin.migration.attach.chooseFiles' | t" (change)="pickAttachments($any($event.target))" />
              </div>
              <p class="migration__hint">{{ 'ui.admin.migration.attach.limits' | t: { limit: store.attachLimit } }}</p>
              @let held = store.attachTotals();
              <div class="migration__stats">
                <strong>{{ 'ui.admin.migration.attach.summary' | t: { count: held.count, limit: store.attachLimit, size: held.size } }}</strong>
                <div class="admin__bar" role="progressbar" [attr.aria-label]="'ui.admin.migration.attach.title' | t" aria-valuemin="0" [attr.aria-valuemax]="store.attachLimit" [attr.aria-valuenow]="held.count"><i [style.width.%]="(held.count / store.attachLimit) * 100"></i></div>
              </div>
              @if (s.upload; as u) {
                <div class="migration__progress" role="status">
                  <strong>{{ 'ui.admin.migration.attach.uploading' | t: { done: u.done, total: u.total } }}</strong>
                  <div class="admin__bar" role="progressbar" aria-valuemin="0" [attr.aria-valuemax]="u.total" [attr.aria-valuenow]="u.done"><i [style.width.%]="u.total ? (u.done / u.total) * 100 : 0"></i></div>
                </div>
              }
              @if (s.refused.length) {
                <div class="notice error" role="alert">
                  <strong>{{ 'ui.admin.migration.attach.refusedTitle' | t: { count: s.refused.length } }}</strong>
                  <ul class="migration__refused">
                    @for (r of s.refused.slice(0, 20); track $index) {
                      <li><b>{{ r.name }}</b>: {{ r.message }}</li>
                    }
                  </ul>
                  @if (s.refused.length > 20) {
                    <div>{{ 'ui.admin.migration.attach.refusedMore' | t: { count: s.refused.length - 20 } }}</div>
                  }
                </div>
              }
              @if (held.count || store.attachQuery()) {
                <div class="migration__search">
                  <input type="search" [value]="store.attachQuery()" [attr.aria-label]="'ui.admin.migration.attach.search' | t" [placeholder]="'ui.admin.migration.attach.search' | t" (input)="store.searchAttachments($any($event.target).value)" />
                  <button appBtn="danger" size="sm" type="button" [disabled]="off || !held.count" (click)="store.confirmClear.set(true)">{{ 'ui.admin.migration.attach.clear' | t }}</button>
                </div>
              }
              @if (s.attachmentList; as list) {
                @if (list.items.length) {
                  <ul class="admin__list migration__list">
                    @for (a of list.items; track a.id) {
                      <li class="admin__row">
                        <span class="admin__label">
                          <strong [title]="a.path">{{ a.path }}</strong>
                          <span class="muted">{{ store.size(a.size) }} · {{ a.usedBy ? ('ui.admin.migration.attach.usedBy' | t: { count: a.usedBy }) : ('ui.admin.migration.attach.notUsed' | t) }}</span>
                        </span>
                        <button appBtn="danger" size="sm" type="button" class="migration__icon-btn" [disabled]="off" [attr.aria-label]="'ui.admin.migration.attach.remove' | t: { path: a.path }" [title]="'ui.admin.migration.remove' | t" (click)="store.removeAttachment(a.id)"><app-icon name="delete" /></button>
                      </li>
                    }
                  </ul>
                  @if (list.total > store.attachPage) {
                    <div class="migration__pager">
                      <button appBtn size="sm" type="button" [disabled]="store.attachOffset() === 0" (click)="store.pageAttachments(-1)">{{ 'ui.admin.migration.attach.prev' | t }}</button>
                      <span class="muted" role="status">{{ 'ui.admin.migration.attach.range' | t: { from: store.attachOffset() + 1, to: store.attachOffset() + list.items.length, total: list.total } }}</span>
                      <button appBtn size="sm" type="button" [disabled]="store.attachOffset() + store.attachPage >= list.total" (click)="store.pageAttachments(1)">{{ 'ui.admin.migration.attach.next' | t }}</button>
                    </div>
                  }
                } @else {
                  <p class="migration__hint" role="status">{{ (store.attachQuery() ? 'ui.admin.migration.attach.noMatch' : 'ui.admin.migration.attach.empty') | t }}</p>
                }
              }
              @if (store.confirmClear()) {
                <div class="migration__shade" data-dialog-shade role="presentation">
                  <div class="card migration__dialog" appDialog role="dialog" aria-labelledby="migration-clear-title" (escape)="store.confirmClear.set(false)">
                    <h2 id="migration-clear-title">{{ 'ui.admin.migration.attach.clearTitle' | t }}</h2>
                    <p>{{ 'ui.admin.migration.attach.clearBody' | t: { count: held.count } }}</p>
                    <div class="admin__line">
                      <button appBtn type="button" (click)="store.confirmClear.set(false)">{{ 'ui.common.cancel' | t }}</button>
                      <button appBtn="danger" type="button" (click)="store.clearAttachments()">{{ 'ui.admin.migration.attach.clearConfirm' | t }}</button>
                    </div>
                  </div>
                </div>
              }
            }

            @case ('map') {
              @if (!p.sources.length) {
                <div class="migration__empty">
                  <span class="migration__icon"><app-icon name="file" /></span>
                  <span>{{ 'ui.admin.migration.noFiles' | t }}</span>
                </div>
              } @else {
                <div class="migration__files" role="group" [attr.aria-label]="'ui.admin.migration.group.title' | t">
                  @for (g of store.groups(); track g.key) {
                    <button type="button" class="migration__chip" [class.migration__chip--on]="g.key === store.group()" [attr.aria-pressed]="g.key === store.group()" (click)="store.openGroupOf(g.key)">
                      <span>{{ 'ui.admin.migration.group.chip' | t: { group: store.groupLabel(g.key), count: g.files.length } }}</span>
                    </button>
                  }
                  <select class="migration__add-group" [attr.aria-label]="'ui.admin.migration.group.add' | t" (change)="store.addGroup($any($event.target).value); $any($event.target).value = ''">
                    <option value="">{{ 'ui.admin.migration.group.add' | t }}</option>
                    @if (!store.hasPeopleGroup()) {
                      <option [value]="store.peopleGroup" [disabled]="store.peopleOption().disabled">{{ store.peopleOption().label | t }}</option>
                    }
                    @for (type of store.groupChoices(); track type.key) {
                      <option [value]="type.key">{{ type.label }}</option>
                    }
                  </select>
                </div>
                @if (!store.peopleAllowed() && !store.hasPeopleGroup()) {
                  <p class="migration__hint">{{ 'ui.admin.migration.kindNoPeople' | t }}</p>
                }
                @if (!store.types().length) {
                  <div class="notice warn" role="status">{{ 'ui.admin.migration.noTypes' | t }}</div>
                }
                @if (store.ungrouped().length) {
                  <div class="notice warn" role="status">{{ 'ui.admin.migration.group.ungrouped' | t: { count: store.ungrouped().length, files: ungroupedNames() } }}</div>
                }
                @if (store.openGroup(); as g) {
                  <section class="migration__target" aria-labelledby="migration-group-title">
                    <div class="migration__target-head">
                      <strong id="migration-group-title">{{ store.groupLabel(g.key) }}</strong>
                      @if (!g.files.length) {
                        <button appBtn size="sm" type="button" (click)="store.dropGroup(g.key)">{{ 'ui.admin.migration.group.drop' | t }}</button>
                      }
                    </div>
                    <div class="migration__target-body">
                      <fieldset class="migration__kind">
                        <legend>{{ (g.key === store.peopleGroup ? 'ui.admin.migration.group.linkPeople' : 'ui.admin.migration.group.linkRecords') | t: { group: store.groupLabel(g.key) } }}</legend>
                        @for (src of p.sources; track src.id) {
                          @let l = store.linkOf(src);
                          <label class="migration__option" [class.migration__option--on]="l.linked" [class.migration__option--off]="!!l.refusal">
                            <input type="checkbox" [checked]="l.linked" [disabled]="!!l.refusal" [attr.aria-describedby]="l.refusal ? 'link-' + src.id : null" (change)="store.setLinked(src, $any($event.target).checked)" />
                            <span>
                              <strong>{{ src.fileName }}</strong>
                              <span class="migration__hint">{{ 'ui.admin.migration.fileFacts' | t: { columns: src.columns.length, rows: src.rowCount } }}</span>
                              @if (l.refusal) {
                                <span class="migration__hint" [id]="'link-' + src.id">{{ l.refusal | t }}</span>
                              }
                            </span>
                          </label>
                        }
                      </fieldset>
                      @if (g.key !== store.peopleGroup && g.files.length) {
                        <h3 class="migration__section">{{ 'ui.admin.migration.group.coverage' | t }}</h3>
                        <table class="migration__coverage">
                          <thead>
                            <tr>
                              <th scope="col">{{ 'ui.admin.migration.group.field' | t }}</th>
                              <th scope="col">{{ 'ui.admin.migration.group.from' | t }}</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (c of store.coverage(); track c.field.key) {
                              <tr>
                                <th scope="row">{{ c.field.label }}@if (c.field.required) {<span class="migration__req" aria-hidden="true"> *</span>}</th>
                                <td>
                                  @for (f of c.from; track $index) {
                                    <div>{{ f.column ? ('ui.admin.migration.group.fromColumn' | t: { file: f.fileName, column: f.column }) : ('ui.admin.migration.group.fromTarget' | t: { file: f.fileName, target: store.targetLabel(f.sourceId, f.target ?? '') }) }}</div>
                                  } @empty {
                                    @if (c.field.required) {
                                      <span class="migration__issue">{{ 'ui.admin.migration.group.missingRequired' | t }}</span>
                                    } @else {
                                      <span class="muted">{{ 'ui.admin.migration.group.notFilled' | t }}</span>
                                    }
                                  }
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      }
                      @if (g.files.length) {
                        <h3 class="migration__section">{{ 'ui.admin.migration.group.columns' | t }}</h3>
                        <div class="migration__files" role="group" [attr.aria-label]="'ui.admin.migration.group.fileTabs' | t">
                          @for (id of g.files; track id) {
                            <button type="button" class="migration__chip" [class.migration__chip--on]="id === store.selected()" [attr.aria-pressed]="id === store.selected()" (click)="store.pick(id)">
                              @if (store.saved(id)) {
                                <app-icon name="check" />
                              }
                              <span>{{ store.fileName(id) }}</span>
                              @if (store.dirty().has(id)) {
                                <span class="migration__unsaved">{{ 'ui.admin.migration.group.unsavedFile' | t }}</span>
                              }
                            </button>
                          }
                        </div>
                      } @else {
                        <p class="migration__hint">{{ 'ui.admin.migration.group.empty' | t }}</p>
                      }
                @if (store.source(); as src) {
                  @if (store.kind() === 'people' && g.key === store.peopleGroup) {
                    <p class="migration__hint">{{ 'ui.admin.migration.peopleSummary' | t: { file: src.fileName, rows: src.rowCount } }}</p>
                    @let d = store.people();
                    <div class="migration__grid">
                      @for (f of peopleFields; track f.key) {
                        <label class="migration__field">
                          <span>{{ 'ui.admin.migration.people.' + f.key | t }}@if (f.required) {<span class="migration__req" aria-hidden="true"> *</span>}</span>
                          <select [attr.aria-required]="f.required" (change)="store.setPeople(f.key, $any($event.target).value)">
                            <option value="" [selected]="!d[f.key]">{{ (f.required ? 'ui.admin.migration.chooseColumn' : 'ui.admin.migration.notInFile') | t }}</option>
                            @for (col of src.columns; track col.name) {
                              <option [value]="col.name" [selected]="d[f.key] === col.name">{{ store.columnLabel(col) }}</option>
                            }
                          </select>
                          <span class="migration__hint">{{ 'ui.admin.migration.people.' + f.key + 'Hint' | t }}</span>
                          @if (store.issue('/people/' + f.key); as e) {
                            <span class="migration__issue">{{ e }}</span>
                          }
                        </label>
                      }
                    </div>
                    <h3 class="migration__section">{{ 'ui.admin.migration.peopleStatus' | t }}</h3>
                    <div class="migration__grid">
                      <label class="migration__field">
                        <span>{{ 'ui.admin.migration.people.statusColumn' | t }}</span>
                        <select (change)="store.setPeople('statusColumn', $any($event.target).value)">
                          <option value="" [selected]="!d.statusColumn">{{ 'ui.admin.migration.notInFile' | t }}</option>
                          @for (col of src.columns; track col.name) {
                            <option [value]="col.name" [selected]="d.statusColumn === col.name">{{ store.columnLabel(col) }}</option>
                          }
                        </select>
                        <span class="migration__hint">{{ 'ui.admin.migration.people.statusColumnHint' | t }}</span>
                        @if (store.issue('/people/status/column') || store.issue('/people/status'); as e) {
                          <span class="migration__issue">{{ e }}</span>
                        }
                      </label>
                      @if (d.statusColumn) {
                        <label class="migration__field">
                          <span>{{ 'ui.admin.migration.peopleActive' | t }}</span>
                          <input type="text" [value]="d.active" (input)="store.setPeople('active', $any($event.target).value)" />
                          <span class="migration__hint">{{ 'ui.admin.migration.peopleValuesHint' | t }}</span>
                          @if (store.issue('/people/status/active'); as e) {
                            <span class="migration__issue">{{ e }}</span>
                          }
                        </label>
                        <label class="migration__field">
                          <span>{{ 'ui.admin.migration.peopleSuspended' | t }}</span>
                          <input type="text" [value]="d.suspended" (input)="store.setPeople('suspended', $any($event.target).value)" />
                          <span class="migration__hint">{{ 'ui.admin.migration.peopleValuesHint' | t }}</span>
                          @if (store.issue('/people/status/suspended'); as e) {
                            <span class="migration__issue">{{ e }}</span>
                          }
                        </label>
                      }
                    </div>
                    <h3 class="migration__section">{{ 'ui.admin.migration.peopleRoles' | t }}</h3>
                    <div class="migration__grid">
                      <label class="migration__field">
                        <span>{{ 'ui.admin.migration.people.rolesColumn' | t }}</span>
                        <select (change)="store.setPeople('rolesColumn', $any($event.target).value)">
                          <option value="" [selected]="!d.rolesColumn">{{ 'ui.admin.migration.notInFile' | t }}</option>
                          @for (col of src.columns; track col.name) {
                            <option [value]="col.name" [selected]="d.rolesColumn === col.name">{{ store.columnLabel(col) }}</option>
                          }
                        </select>
                        <span class="migration__hint">{{ 'ui.admin.migration.people.rolesColumnHint' | t }}</span>
                        @if (store.issue('/people/roles/column') || store.issue('/people/roles'); as e) {
                          <span class="migration__issue">{{ e }}</span>
                        }
                      </label>
                      @if (d.rolesColumn) {
                        <label class="migration__field">
                          <span>{{ 'ui.admin.migration.peopleSeparator' | t }}</span>
                          <select (change)="store.setPeople('separator', $any($event.target).value)">
                            @for (sep of separators; track sep.value) {
                              <option [value]="sep.value" [selected]="d.separator === sep.value">{{ 'ui.admin.migration.separator.' + sep.key | t }}</option>
                            }
                          </select>
                          @if (store.issue('/people/roles/separator'); as e) {
                            <span class="migration__issue">{{ e }}</span>
                          }
                        </label>
                      }
                    </div>
                    @if (d.rolesColumn) {
                      @if (store.rolesFailed()) {
                        <div class="notice warn" role="status">{{ 'ui.admin.migration.rolesUnavailable' | t }}</div>
                      }
                      <div class="migration__roles" role="group" [attr.aria-label]="'ui.admin.migration.roleMapTitle' | t">
                        <div class="migration__roles-head"><span>{{ 'ui.admin.migration.roleMapTitle' | t }}</span><span>{{ 'ui.admin.migration.roleBecomes' | t }}</span></div>
                        @for (r of store.roleTable(); track r.value) {
                          <div class="migration__role">
                            <b>{{ r.value }}</b>
                            <select [attr.aria-label]="'ui.admin.migration.roleFor' | t: { value: r.value }" (change)="store.setRole(r.value, $any($event.target).value)">
                              <option value="" [selected]="!r.role">{{ 'ui.admin.migration.roleIgnore' | t }}</option>
                              @for (role of store.roles(); track role.key) {
                                <option [value]="role.key" [selected]="r.role === role.key" [disabled]="!!role.requireTwoStep && r.role !== role.key">{{ (role.requireTwoStep ? 'ui.admin.migration.roleTwoStepOption' : 'ui.admin.migration.roleOption') | t: { role: role.label } }}</option>
                              }
                            </select>
                            @if (r.role && store.twoStep(r.role)) {
                              <span class="migration__issue">{{ 'ui.admin.migration.roleTwoStep' | t: { role: store.roleLabel(r.role) } }}</span>
                            }
                            @if (store.issue('/people/roles/map/' + r.value); as e) {
                              <span class="migration__issue">{{ e }}</span>
                            }
                          </div>
                        } @empty {
                          <p class="migration__hint">{{ 'ui.admin.migration.roleNone' | t }}</p>
                        }
                      </div>
                      <p class="migration__hint">{{ 'ui.admin.migration.roleValuesNote' | t }}</p>
                      <div class="migration__add-role">
                        <label class="migration__field">
                          <span>{{ 'ui.admin.migration.roleAddValue' | t }}</span>
                          <input type="text" [value]="store.addedRoleValue()" (input)="store.addedRoleValue.set($any($event.target).value)" (keydown.enter)="$event.preventDefault(); store.addRoleValue()" />
                        </label>
                        <button appBtn size="sm" type="button" [disabled]="!store.addedRoleValue().trim()" (click)="store.addRoleValue()">{{ 'ui.admin.migration.roleAdd' | t }}</button>
                      </div>
                    }
                    <div class="notice ok" role="status">{{ 'ui.admin.migration.peopleReady' | t }}</div>
                  } @else if (store.kind() === 'records') {
                  @for (x of store.draft(); track x.key; let i = $index) {
                    @if (x.type === g.key) {
                    @let f = store.filled(x);
                    <div class="migration__file-target">
                      <p class="migration__hint">{{ 'ui.admin.migration.group.fileFields' | t: { file: src.fileName } }} · {{ 'ui.admin.migration.fieldsFilled' | t: { count: f.count, total: f.total } }}</p>
                      <div>
                        <div class="migration__grid">
                          <label class="migration__field">
                            <span>{{ 'ui.admin.migration.oldId' | t }}</span>
                            <select (change)="store.setOldId(i, $any($event.target).value)">
                              @for (c of store.columns(); track c) {
                                <option [value]="c" [selected]="c === x.oldId">{{ c }}</option>
                              }
                            </select>
                            <span class="migration__hint">{{ 'ui.admin.migration.oldIdHint' | t }}</span>
                            @if (store.issue('/targets/' + i + '/oldId'); as e) {
                              <span class="migration__issue">{{ e }}</span>
                            }
                          </label>
                          <div class="migration__field">
                            <label class="migration__check"><input type="checkbox" [checked]="x.required" (change)="store.setRequired(i, $any($event.target).checked)" /> {{ 'ui.admin.migration.required' | t }}</label>
                            <span class="migration__hint">{{ 'ui.admin.migration.requiredHint' | t }}</span>
                          </div>
                        </div>
                        <div class="migration__grid">
                          @for (c of store.choices(x); track c.field.key) {
                            <label class="migration__field">
                              <span>{{ c.field.label }}@if (c.field.required) {<span class="migration__req" aria-hidden="true"> *</span>}</span>
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
                            @if (c.person) {
                              <div class="migration__person">
                                <label class="migration__field">
                                  <span>{{ 'ui.admin.migration.personLegacy' | t: { field: c.field.label } }}</span>
                                  <select (change)="store.choosePerson(i, c, $any($event.target).value)">
                                    <option value="" [selected]="!c.legacyColumn">{{ 'ui.admin.migration.notImported' | t }}</option>
                                    @for (col of store.columns(); track col) {
                                      <option [value]="col" [selected]="c.legacyColumn === col">{{ col }}</option>
                                    }
                                  </select>
                                  <span class="migration__hint">{{ 'ui.admin.migration.personLegacyHint' | t }}</span>
                                  @if (store.issue('/targets/' + i + '/persons/' + c.field.key + '/column') || store.issue('/targets/' + i + '/persons/' + c.field.key); as e) {
                                    <span class="migration__issue">{{ e }}</span>
                                  }
                                </label>
                                @if (c.legacyColumn) {
                                  <label class="migration__field">
                                    <span>{{ 'ui.admin.migration.personOnMissing' | t }}</span>
                                    <select (change)="store.setOnMissing(i, c, $any($event.target).value)">
                                      <option value="blank" [selected]="c.onMissing === 'blank'">{{ 'ui.admin.migration.personBlank' | t }}</option>
                                      <option value="fail" [selected]="c.onMissing === 'fail'">{{ 'ui.admin.migration.personFail' | t }}</option>
                                    </select>
                                    @if (store.issue('/targets/' + i + '/persons/' + c.field.key + '/onMissing'); as e) {
                                      <span class="migration__issue">{{ e }}</span>
                                    }
                                  </label>
                                }
                              </div>
                            }
                          }
                        </div>
                        @for (fc of store.fileChoices(x); track fc.field.key) {
                          <div class="migration__person">
                            <label class="migration__field">
                              <span>{{ 'ui.admin.migration.file.column' | t: { field: fc.field.label } }}@if (fc.field.required) {<span class="migration__req" aria-hidden="true"> *</span>}</span>
                              <select [attr.aria-required]="fc.field.required" (change)="store.chooseFile(i, fc, $any($event.target).value)">
                                <option value="" [selected]="!fc.column">{{ 'ui.admin.migration.notImported' | t }}</option>
                                @for (col of src.columns; track col.name) {
                                  <option [value]="col.name" [selected]="fc.column === col.name">{{ store.columnLabel(col) }}</option>
                                }
                              </select>
                              <span class="migration__hint">{{ 'ui.admin.migration.file.columnHint' | t }}</span>
                              @if (store.issue('/targets/' + i + '/files/' + fc.field.key + '/column') || store.issue('/targets/' + i + '/files/' + fc.field.key); as e) {
                                <span class="migration__issue">{{ e }}</span>
                              }
                            </label>
                            @if (fc.column) {
                              <label class="migration__field">
                                <span>{{ 'ui.admin.migration.file.onMissing' | t }}</span>
                                <select (change)="store.setFileOption(i, fc, 'onMissing', $any($event.target).value)">
                                  <option value="fail" [selected]="fc.onMissing === 'fail'">{{ 'ui.admin.migration.file.fail' | t }}</option>
                                  <option value="skip" [selected]="fc.onMissing === 'skip'">{{ 'ui.admin.migration.file.skip' | t }}</option>
                                </select>
                                @if (store.issue('/targets/' + i + '/files/' + fc.field.key + '/onMissing'); as e) {
                                  <span class="migration__issue">{{ e }}</span>
                                }
                              </label>
                              @if (fc.field.multiple) {
                                <label class="migration__field">
                                  <span>{{ 'ui.admin.migration.file.separator' | t }}</span>
                                  <select (change)="store.setFileOption(i, fc, 'separator', $any($event.target).value)">
                                    <option value=";" [selected]="fc.separator === ';'">{{ 'ui.admin.migration.separator.semicolon' | t }}</option>
                                    <option value="," [selected]="fc.separator === ','">{{ 'ui.admin.migration.separator.comma' | t }}</option>
                                  </select>
                                  @if (store.issue('/targets/' + i + '/files/' + fc.field.key + '/separator'); as e) {
                                    <span class="migration__issue">{{ e }}</span>
                                  }
                                </label>
                              }
                            }
                          </div>
                        }
                      </div>
                    </div>
                    }
                  }
                  }
                }
                    </div>
                  </section>
                } @else {
                  <p class="migration__hint">{{ 'ui.admin.migration.group.none' | t }}</p>
                }
                <div class="migration__actions">
                  @if (store.unsaved().length) {
                    <span class="migration__hint" role="status">{{ 'ui.admin.migration.group.unsaved' | t: { count: store.unsaved().length } }}</span>
                  }
                  <button appBtn="primary" type="button" [disabled]="s.busy || !store.canSave() || store.running()" (click)="store.saveMapping()">{{ 'ui.admin.migration.saveMapping' | t }}</button>
                </div>
              }
            }

            @case ('order') {
              <ul class="admin__list migration__list">
                @for (src of p.sources; track src.id; let i = $index, first = $first, last = $last) {
                  <li class="admin__row">
                    <span class="migration__pos">{{ i + 1 }}</span>
                    <span class="admin__label">
                      <strong>{{ src.fileName }}</strong>
                      <span class="muted">{{ src.mapping ? store.contents(src.mapping) : ('ui.admin.migration.leftOut' | t) }}</span>
                    </span>
                    @if (src.mapping?.kind === 'people') {
                      <span class="badge ok">{{ 'ui.admin.migration.kindPeople' | t }}</span>
                    }
                    <button appBtn size="sm" type="button" class="migration__icon-btn" [disabled]="first || off" [attr.aria-label]="'ui.admin.migration.up' | t" [title]="'ui.admin.migration.up' | t" (click)="store.move(src.id, -1)"><app-icon name="up" /></button>
                    <button appBtn size="sm" type="button" class="migration__icon-btn" [disabled]="last || off" [attr.aria-label]="'ui.admin.migration.down' | t" [title]="'ui.admin.migration.down' | t" (click)="store.move(src.id, 1)"><app-icon name="down" /></button>
                  </li>
                }
              </ul>
            }

            @case ('books') {
              @if (p.booksAppliedAt) {
                <div class="notice ok" role="status">{{ 'ui.admin.migration.booksAppliedOn' | t: { date: p.booksAppliedAt.slice(0, 10) } }}</div>
              } @else if (!store.booksAllowed()) {
                <div class="notice" role="status">{{ 'ui.admin.migration.booksNoPermission' | t }}</div>
              } @else {
                @let b = store.books();
                <label class="migration__field migration__cutover">
                  <span>{{ 'ui.admin.migration.cutover' | t }}</span>
                  <input type="date" [value]="b.cutoverDate ?? ''" (change)="store.setCutover($any($event.target).value)" />
                </label>
                <h3 class="migration__section">{{ 'ui.admin.migration.lines' | t }}</h3>
                @for (l of b.lines ?? []; track $index; let i = $index) {
                  <div class="migration__line">
                    <label class="migration__field"><span>{{ 'ui.admin.migration.account' | t }}</span><input type="text" [value]="l.accountCode" (input)="store.setLine(i, 'accountCode', $any($event.target).value)" /></label>
                    <label class="migration__field"><span>{{ 'ui.admin.migration.debit' | t }}</span><input type="text" inputmode="decimal" [value]="l.debit ?? ''" (input)="store.setLine(i, 'debit', $any($event.target).value)" /></label>
                    <label class="migration__field"><span>{{ 'ui.admin.migration.credit' | t }}</span><input type="text" inputmode="decimal" [value]="l.credit ?? ''" (input)="store.setLine(i, 'credit', $any($event.target).value)" /></label>
                    <button appBtn="danger" type="button" class="migration__icon-btn" [attr.aria-label]="'ui.admin.migration.remove' | t" [title]="'ui.admin.migration.remove' | t" (click)="store.removeLine(i)"><app-icon name="delete" /></button>
                  </div>
                }
                <div class="migration__actions migration__new">
                  <button appBtn size="sm" type="button" class="migration__btn-icon" (click)="store.addLine()"><app-icon name="add" />{{ 'ui.admin.migration.addLine' | t }}</button>
                  @if ((b.lines ?? []).length) {
                    @let bal = store.balance();
                    <span class="migration__balance" [class.migration__balance--off]="!bal.balanced">
                      @if (bal.balanced) {
                        <app-icon name="check" />
                      }
                      {{ 'ui.admin.migration.balance' | t: { debit: bal.debit / 100, credit: bal.credit / 100 } }}
                    </span>
                  }
                </div>
                <h3 class="migration__section">{{ 'ui.admin.migration.receipts' | t }}</h3>
                @for (r of b.receipts ?? []; track $index; let i = $index) {
                  <div class="migration__line migration__line--short">
                    <label class="migration__field"><span>{{ 'ui.admin.migration.series' | t }}</span><input type="text" [value]="r.series" (input)="store.setReceipt(i, 'series', $any($event.target).value)" /></label>
                    <label class="migration__field"><span>{{ 'ui.admin.migration.next' | t }}</span><input type="number" min="1" step="1" [value]="r.next" (input)="store.setReceipt(i, 'next', $any($event.target).value)" /></label>
                    <button appBtn="danger" type="button" class="migration__icon-btn" [attr.aria-label]="'ui.admin.migration.remove' | t" [title]="'ui.admin.migration.remove' | t" (click)="store.removeReceipt(i)"><app-icon name="delete" /></button>
                  </div>
                }
                <div class="migration__actions">
                  <button appBtn size="sm" type="button" class="migration__btn-icon" (click)="store.addReceipt()"><app-icon name="add" />{{ 'ui.admin.migration.addReceipt' | t }}</button>
                </div>
                <div class="migration__actions">
                  <button appBtn="primary" type="button" [disabled]="off" (click)="store.saveBooks()">{{ 'ui.admin.migration.saveBooks' | t }}</button>
                </div>
              }
            }

            @case ('check') {
              @if (store.checking()) {
                <div class="notice info" role="status">{{ 'ui.admin.migration.checkingBackground' | t }}</div>
              } @else if (p.check; as c) {
                <div class="migration__counts">
                  <div class="migration__stat"><b>{{ c.rows }}</b>{{ 'ui.admin.migration.rows' | t }}</div>
                  <div class="migration__stat" data-tone="ok"><b>{{ c.ready }}</b>{{ 'ui.admin.migration.ready' | t }}</div>
                  <div class="migration__stat" [attr.data-tone]="c.invalid ? 'bad' : null"><b>{{ c.invalid }}</b>{{ 'ui.admin.migration.problems' | t }}</div>
                  <div class="migration__stat" data-tone="brand"><b>{{ c.creates }}</b>{{ 'ui.admin.migration.willCreate' | t }}</div>
                  <div class="migration__stat" data-tone="brand"><b>{{ c.updates }}</b>{{ 'ui.admin.migration.willUpdate' | t }}</div>
                  <div class="migration__stat" [attr.data-tone]="c.warnings.length ? 'warn' : null"><b>{{ c.warnings.length }}</b>{{ 'ui.admin.migration.warningCount' | t }}</div>
                </div>
                @if (store.kinds().length > 1 || store.kinds()[0]?.kind === 'people') {
                  <ul class="admin__list migration__list" [attr.aria-label]="'ui.admin.migration.checkByKind' | t">
                    @for (k of store.kinds(); track k.kind) {
                      <li class="admin__row">
                        <span class="admin__label">
                          <strong>{{ 'ui.admin.migration.kind.' + k.kind | t: { count: k.files } }}</strong>
                          <span class="muted">{{ (k.kind === 'people' ? 'ui.admin.migration.checkPeople' : 'ui.admin.migration.checkRecords') | t: { rows: k.rows, ready: k.ready, invalid: k.invalid, creates: k.creates, updates: k.updates } }}</span>
                        </span>
                      </li>
                    }
                  </ul>
                }
                <ul class="admin__list migration__list">
                  @for (x of c.sources; track x.sourceId) {
                    <li class="admin__row">
                      <span class="migration__icon" [attr.data-status]="x.invalid ? 'problems' : 'ready'"><app-icon name="file" /></span>
                      <span class="admin__label">
                        <strong>{{ x.fileName }}</strong>
                        <span class="muted">{{ 'ui.admin.migration.sourceCheck' | t: { ready: x.ready, invalid: x.invalid, creates: x.creates, updates: x.updates } }}</span>
                      </span>
                      <span [class]="'badge ' + (x.invalid ? 'bad' : 'ok')">{{ (x.invalid ? 'ui.admin.migration.problems' : 'ui.admin.migration.ready') | t }}</span>
                    </li>
                  }
                </ul>
                @if (c.problems.length) {
                  <ul class="migration__problems">
                    @for (x of c.problems; track $index) {
                      <li>{{ (x.row > 0 ? 'ui.admin.migration.problem' : 'ui.admin.migration.problemFile') | t: { file: x.fileName, row: x.row, message: x.message } }}</li>
                    }
                  </ul>
                }
                @if (c.warnings.length) {
                  <p class="migration__hint">{{ 'ui.admin.migration.warnings' | t }}</p>
                  @for (g of store.warningGroups(); track g.kind) {
                    <h3 class="migration__section">{{ g.title | t }}</h3>
                    <ul class="migration__warnings">
                      @for (x of g.items; track $index) {
                        <li>
                          <strong>{{ (x.column || x.target ? 'ui.admin.migration.warningColumn' : 'ui.admin.migration.warning') | t: { file: x.fileName ?? '', column: x.column ?? x.target ?? '', count: x.count } }}</strong>
                          @for (sample of x.samples; track $index) {
                            <div>{{ sample }}</div>
                          }
                          @if (x.more) {
                            <div class="migration__hint">{{ 'ui.admin.migration.warningMore' | t: { count: x.more } }}</div>
                          }
                        </li>
                      }
                    </ul>
                  }
                }
                @if (c.invalid > c.problems.length) {
                  <p class="migration__hint">{{ 'ui.admin.migration.moreProblems' | t: { shown: c.problems.length } }}</p>
                }
              } @else {
                <div class="migration__empty">
                  <span class="migration__icon"><app-icon name="check" /></span>
                  <span>{{ 'ui.admin.migration.notChecked' | t }}</span>
                </div>
              }
              @if (p.status === 'checked' && store.checkErrors()) {
                <div class="notice warn" role="status">{{ 'ui.admin.migration.fixErrorsToRun' | t }}</div>
              }
              <div class="migration__actions">
                <button [appBtn]="p.check ? '' : 'primary'" type="button" [disabled]="off" (click)="store.check()">{{ (p.check ? 'ui.admin.migration.checkAgain' : 'ui.admin.migration.checkNow') | t }}</button>
                @if (p.status === 'checked' && p.check) {
                  <button appBtn="primary" type="button" [disabled]="s.busy || !p.check.ready || store.checkErrors()" (click)="store.run()">{{ 'ui.admin.migration.run' | t: { count: p.check.ready } }}</button>
                }
              </div>
            }

            @case ('run') {
              @if (p.status === 'running') {
                @let job = s.job;
                <div class="notice info" role="status">{{ 'ui.admin.migration.runningBackground' | t }}</div>
                <div class="migration__progress">
                  <div class="migration__progress-top">
                    <strong>{{ 'ui.admin.migration.progress' | t: { done: job?.progress ?? 0, total: job?.total ?? 0 } }}</strong>
                    <b>{{ store.percent() }}%</b>
                  </div>
                  <div class="admin__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="store.percent()"><i [style.width.%]="store.percent()"></i></div>
                </div>
                @if (p.recentFailures?.length) {
                  <div class="migration__log" role="log" aria-live="polite">
                    <strong>{{ 'ui.admin.migration.liveLog' | t }}</strong>
                    <ul class="admin__list migration__list">
                      @for (f of p.recentFailures; track $index) {
                        <li class="admin__row">
                          <span class="migration__icon" data-status="problems"><app-icon name="file" /></span>
                          <span class="admin__label">
                            <strong>{{ f.fileName }}</strong>
                            <span class="muted">{{ f.message }}</span>
                          </span>
                        </li>
                      }
                    </ul>
                  </div>
                }
                <div class="migration__actions"><button appBtn="danger" type="button" [disabled]="s.busy || !!job?.cancelRequested" (click)="store.cancel()">{{ 'ui.admin.migration.cancel' | t }}</button></div>
              } @else if (p.status === 'done') {
                <div class="notice ok" role="status">{{ 'ui.admin.migration.finished' | t }}</div>
              } @else if (p.status === 'failed') {
                <div class="notice error" role="status">{{ 'ui.admin.migration.stopped' | t }}</div>
              } @else {
                <div class="migration__empty">
                  <span class="migration__icon"><app-icon name="forward" /></span>
                  <span>{{ 'ui.admin.migration.notRun' | t }}</span>
                </div>
              }
              @if (p.jobId) {
                <ul class="admin__list migration__list">
                  @for (src of p.sources; track src.id) {
                    @if (src.counts; as k) {
                      <li class="admin__row">
                        <span class="migration__icon" [attr.data-status]="k.failed ? 'problems' : 'done'"><app-icon name="file" /></span>
                        <span class="admin__label">
                          <strong>{{ src.fileName }}</strong>
                          <span class="muted">{{ (src.kind === 'people' ? 'ui.admin.migration.sourceResultPeople' : 'ui.admin.migration.sourceResult') | t: { created: k.created, updated: k.updated, failed: k.failed } }}@if (k.warned) { · {{ 'ui.admin.migration.warnedCount' | t: { count: k.warned } }}}</span>
                        </span>
                        @if (k.failed && p.status !== 'running') {
                          @if (src.purgedAt) {
                            <span class="muted">{{ 'ui.admin.migration.purgedFailed' | t }}</span>
                          } @else {
                            <button appBtn size="sm" type="button" class="migration__btn-icon" (click)="store.downloadFailed(src.id)"><app-icon name="download" />{{ 'ui.admin.migration.downloadFailed' | t }}</button>
                          }
                        }
                        @if (src.purgedAt) {
                          <span class="badge warn">{{ 'ui.admin.migration.sourceDeleted' | t }}</span>
                        }
                      </li>
                    }
                  }
                </ul>
                @if (p.status !== 'running') {
                  @if (p.purgedAt; as when) {
                    <div class="notice ok" role="status">{{ 'ui.admin.migration.purgedOn' | t: { date: when.slice(0, 10) } }}</div>
                    <p class="migration__hint">{{ 'ui.admin.migration.purgedHint' | t }}</p>
                    <div class="migration__actions"><button appBtn="primary" type="button" (click)="store.goStep('files')">{{ 'ui.admin.migration.purgedAdd' | t }}</button></div>
                  } @else {
                    <div class="migration__purge">
                      <p class="migration__hint">{{ 'ui.admin.migration.purge.hint' | t }}</p>
                      <button appBtn="danger" type="button" [disabled]="s.busy" (click)="store.confirmPurge.set(true)">{{ 'ui.admin.migration.purge.button' | t }}</button>
                    </div>
                  }
                }
                @if (store.confirmPurge()) {
                  <div class="migration__shade" data-dialog-shade role="presentation">
                    <div class="card migration__dialog" appDialog role="dialog" aria-labelledby="migration-purge-title" (escape)="store.confirmPurge.set(false)">
                      <h2 id="migration-purge-title">{{ 'ui.admin.migration.purge.title' | t }}</h2>
                      <p>{{ 'ui.admin.migration.purge.body' | t }}</p>
                      <div class="admin__line">
                        <button appBtn type="button" (click)="store.confirmPurge.set(false)">{{ 'ui.common.cancel' | t }}</button>
                        <button appBtn="danger" type="button" [disabled]="s.busy || store.running()" (click)="store.purge()">{{ 'ui.admin.migration.purge.confirm' | t }}</button>
                      </div>
                    </div>
                  </div>
                }
              }
            }
          }

          </fieldset>

          @if (store.step() === 'run') {
            <!-- Outside the fieldset: a done migration is read-only, but its books can still be applied after a failure. -->
            @if (p.booksResult?.error) {
              <div class="notice error migration__actions" role="alert">{{ 'ui.admin.migration.booksError' | t: { error: p.booksResult?.error ?? '' } }}</div>
              @if (store.booksAllowed() && p.status === 'done' && !p.booksAppliedAt) {
                <div class="migration__actions"><button appBtn="primary" type="button" [disabled]="s.busy" (click)="store.applyBooks()">{{ 'ui.admin.migration.applyBooks' | t }}</button></div>
              }
            } @else if (p.booksAppliedAt) {
              <div class="notice ok migration__actions" role="status">{{ 'ui.admin.migration.booksAppliedOn' | t: { date: p.booksAppliedAt.slice(0, 10) } }}</div>
            }
          }

          <div class="migration__nav">
            @if (store.prevStep(); as back) {
              <button appBtn type="button" class="migration__btn-icon" (click)="store.goStep(back)"><app-icon name="back" />{{ 'ui.common.back' | t }}</button>
            }
            <span class="migration__spacer"></span>
            @if (store.nextStep(); as next) {
              <button [appBtn]="store.done().has(store.step()) ? 'primary' : ''" type="button" class="migration__btn-icon" [disabled]="!store.enabled().has(next)" (click)="store.goStep(next)">{{ 'ui.common.next' | t }}<app-icon name="forward" /></button>
            }
          </div>
        </section>
      }
    </app-page-frame>
  `,
})
export class MigrationScreen {
  readonly store = inject(MigrationStore);
  readonly steps = MIGRATION_STEPS;
  /** A file is being dragged over the drop area. */
  readonly over = signal(false);
  /** Attachments are being dragged over their drop area. */
  readonly overFiles = signal(false);
  readonly separators = ROLE_SEPARATORS.map((value, i) => ({ value, key: ['semicolon', 'comma', 'bar'][i]! }));
  /** The columns of a people file that take one column each. */
  readonly peopleFields = [
    { key: 'oldId', required: true },
    { key: 'email', required: true },
    { key: 'name', required: true },
    { key: 'locale', required: false },
  ] as const;

  /** The files no group holds, by name, for the notice that they are left out. */
  ungroupedNames(): string {
    return this.store.ungrouped().map((s) => s.fileName).join(', ');
  }

  /** The catalogue key of the line that explains a step. */
  intro(step: MigrationStep): string {
    return `ui.admin.migration.${step}Intro`;
  }

  /** The badge colour of a status. */
  tone(status: ProfileStatus): string {
    return status === 'done' ? 'ok' : status === 'failed' ? 'bad' : status === 'checked' ? 'warn' : '';
  }

  drop(e: DragEvent, off: boolean): void {
    e.preventDefault();
    this.over.set(false);
    if (!off) this.store.addFiles(e.dataTransfer?.files ?? null);
  }

  /** Attachments dropped: files and folders, each under its path. */
  dropAttachments(e: DragEvent, off: boolean): void {
    e.preventDefault();
    this.overFiles.set(false);
    // The drop's entries are read now: the browser empties them when the event ends.
    if (!off) void droppedFiles(e.dataTransfer).then((files) => this.store.addAttachments(files));
  }

  pickAttachments(input: HTMLInputElement): void {
    const files = pickedFiles(input.files);
    input.value = '';
    void this.store.addAttachments(files);
  }
}
