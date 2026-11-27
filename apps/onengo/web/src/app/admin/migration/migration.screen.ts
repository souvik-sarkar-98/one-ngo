import { Component, inject, signal } from '@angular/core';
import { Btn, Icon, PageFrame } from '@onengo/web-kit';
import { MIGRATION_STEPS, ROLE_SEPARATORS, type ImportKind, type MigrationStep, type ProfileStatus } from '../../core/admin/migration';
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
              <label class="migration__field migration__import">
                <span>{{ 'ui.admin.migration.importType' | t }}</span>
                <select [disabled]="off" [attr.aria-label]="'ui.admin.migration.importType' | t" aria-describedby="migration-import-hint" (change)="pickKind($any($event.target))">
                  @for (o of store.kindChoices(); track o.kind) {
                    <option [value]="o.kind" [selected]="o.kind === store.importKind()" [disabled]="o.disabled">{{ o.option | t }}</option>
                  }
                </select>
                <span class="migration__hint" id="migration-import-hint">{{ store.importOption().hint | t }}</span>
              </label>
              @if (store.confirmKind()) {
                <div class="migration__shade" data-dialog-shade role="presentation">
                  <div class="card migration__dialog" appDialog role="dialog" aria-labelledby="migration-reset-title" (escape)="store.confirmKind.set(null)">
                    <h2 id="migration-reset-title">{{ 'ui.admin.migration.reset.title' | t }}</h2>
                    <p>{{ 'ui.admin.migration.reset.body' | t: { count: p.sources.length, files: store.attachTotals().count } }}</p>
                    <div class="admin__line">
                      <button appBtn type="button" (click)="store.confirmKind.set(null)">{{ 'ui.common.cancel' | t }}</button>
                      <button appBtn="danger" type="button" (click)="store.applyKind()">{{ 'ui.admin.migration.reset.confirm' | t }}</button>
                    </div>
                  </div>
                </div>
              }
              @if (store.importKind() === 'files') {
                <h3 class="migration__section">{{ 'ui.admin.migration.filesKind.csvTitle' | t }}</h3>
                <p class="migration__hint">{{ 'ui.admin.migration.filesKind.csvHint' | t }}</p>
              }
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
                      <span class="badge">{{ store.kindLabelOf(src) | t }}</span>
                      @if (src.purgedAt) {
                        <span class="badge warn">{{ 'ui.admin.migration.sourceDeleted' | t }}</span>
                      }
                      <span [class]="'badge ' + (src.mapping ? 'ok' : 'warn')">{{ (src.mapping ? 'ui.admin.migration.mapped' : 'ui.admin.migration.notMapped') | t }}</span>
                      <button appBtn="danger" size="sm" type="button" class="migration__icon-btn" [disabled]="off" [attr.aria-label]="'ui.admin.migration.remove' | t" [title]="'ui.admin.migration.remove' | t" (click)="store.removeSource(src.id)"><app-icon name="delete" /></button>
                    </li>
                  }
                </ul>
              }
              @if (store.importKind() === 'files') {
              <h3 class="migration__section">{{ 'ui.admin.migration.filesKind.filesTitle' | t }}</h3>
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
            }

            @case ('map') {
              @if (!p.sources.length) {
                <div class="migration__empty">
                  <span class="migration__icon"><app-icon name="file" /></span>
                  <span>{{ 'ui.admin.migration.noFiles' | t }}</span>
                </div>
              } @else {
                @if (store.kindsPresent().length > 1) {
                  <label class="migration__field migration__import">
                    <span>{{ 'ui.admin.migration.mapKind' | t }}</span>
                    <select (change)="store.setMapKind($any($event.target).value)">
                      @for (k of store.kindsPresent(); track k) {
                        <option [value]="k" [selected]="k === store.mapKind()">{{ store.kindLabel(k) | t }}</option>
                      }
                    </select>
                  </label>
                }
                @if (store.mapKind() === 'records') {
                  <div class="migration__files" role="group" [attr.aria-label]="'ui.admin.migration.group.title' | t">
                    @for (g of store.recordGroups(); track g.key) {
                      <button type="button" class="migration__chip" [class.migration__chip--on]="g.key === store.group()" [attr.aria-pressed]="g.key === store.group()" (click)="store.openGroupOf(g.key)">
                        <span>{{ 'ui.admin.migration.group.chip' | t: { group: store.groupLabel(g.key), count: g.files.length } }}</span>
                      </button>
                    }
                    <select class="migration__add-group" [attr.aria-label]="'ui.admin.migration.group.add' | t" (change)="store.addGroup($any($event.target).value); $any($event.target).value = ''">
                      <option value="">{{ 'ui.admin.migration.group.add' | t }}</option>
                      @for (type of store.groupChoices(); track type.key) {
                        <option [value]="type.key">{{ type.label }}</option>
                      }
                    </select>
                  </div>
                }
                @if (!store.types().length) {
                  <div class="notice warn" role="status">{{ 'ui.admin.migration.noTypes' | t }}</div>
                }
                @if (store.ungrouped().length) {
                  <div class="notice warn" role="status">{{ 'ui.admin.migration.group.ungrouped' | t: { count: store.ungrouped().length, files: ungroupedNames() } }}</div>
                }
                @if (store.mapKind() === 'files') {
                  <section class="migration__target" aria-labelledby="migration-files-title">
                    <div class="migration__target-head">
                      <strong id="migration-files-title">{{ 'ui.admin.migration.kindFiles' | t }}</strong>
                    </div>
                    <div class="migration__target-body">
                      <p class="migration__hint">{{ 'ui.admin.migration.filesKind.mapHint' | t }}</p>
                      @if (!store.fileTypes().length) {
                        <div class="notice warn" role="status">{{ 'ui.admin.migration.filesKind.noTypes' | t }}</div>
                      }
                      @for (src of store.filesSources(); track src.id) {
                        @let tg = store.filesTarget(src.id);
                        <fieldset class="migration__kind">
                          <legend>{{ src.fileName }}</legend>
                          <span class="migration__hint">{{ 'ui.admin.migration.fileFacts' | t: { columns: src.columns.length, rows: src.rowCount } }}</span>
                          <div class="migration__strip">
                            <label class="migration__field">
                              <span>{{ 'ui.admin.migration.filesKind.recordType' | t }}</span>
                              <select (change)="store.setFilesType(src.id, $any($event.target).value)">
                                <option value="" [selected]="!tg" [disabled]="!!src.mapping">{{ 'ui.admin.migration.filesKind.chooseType' | t }}</option>
                                @for (type of store.fileTypes(); track type.key) {
                                  <option [value]="type.key" [selected]="type.key === store.filesTypeOf(src.id)">{{ type.label }}</option>
                                }
                              </select>
                            </label>
                          </div>
                          @if (tg) {
                            <div class="migration__strip">
                              <label class="migration__field">
                                <span>{{ 'ui.admin.migration.oldId' | t }}</span>
                                <select (change)="store.setFilesOldId(src.id, $any($event.target).value)">
                                  @for (col of src.columns; track col.name) {
                                    <option [value]="col.name" [selected]="col.name === tg.oldId">{{ col.name }}</option>
                                  }
                                </select>
                                <span class="migration__hint">{{ 'ui.admin.migration.filesKind.oldIdHint' | t }}</span>
                                @if (store.filesIssue(src.id, '/oldId'); as e) {
                                  <span class="migration__issue">{{ e }}</span>
                                }
                              </label>
                            </div>
                            @for (c of store.filesChoices(src.id); track c.field.key) {
                              <div class="migration__strip">
                                <label class="migration__field">
                                  <span>{{ c.field.label }}</span>
                                  <select (change)="store.setFilesColumn(src.id, c, $any($event.target).value)">
                                    <option value="" [selected]="!c.column">{{ 'ui.admin.migration.notImported' | t }}</option>
                                    @for (col of src.columns; track col.name) {
                                      <option [value]="col.name" [selected]="c.column === col.name">{{ store.columnLabel(col) }}</option>
                                    }
                                  </select>
                                  <span class="migration__hint">{{ 'ui.admin.migration.file.columnHint' | t }}</span>
                                  @if (store.filesIssue(src.id, '/files/' + c.field.key + '/column') || store.filesIssue(src.id, '/files/' + c.field.key); as e) {
                                    <span class="migration__issue">{{ e }}</span>
                                  }
                                </label>
                                @if (c.column) {
                                  <label class="migration__field">
                                    <span>{{ 'ui.admin.migration.file.onMissing' | t }}</span>
                                    <select (change)="store.setFilesOption(src.id, c, 'onMissing', $any($event.target).value)">
                                      <option value="fail" [selected]="c.onMissing === 'fail'">{{ 'ui.admin.migration.file.fail' | t }}</option>
                                      <option value="skip" [selected]="c.onMissing === 'skip'">{{ 'ui.admin.migration.file.skip' | t }}</option>
                                    </select>
                                  </label>
                                  @if (c.field.multiple) {
                                    <label class="migration__field">
                                      <span>{{ 'ui.admin.migration.file.separator' | t }}</span>
                                      <select (change)="store.setFilesOption(src.id, c, 'separator', $any($event.target).value)">
                                        <option value=";" [selected]="c.separator === ';'">{{ 'ui.admin.migration.separator.semicolon' | t }}</option>
                                        <option value="," [selected]="c.separator === ','">{{ 'ui.admin.migration.separator.comma' | t }}</option>
                                      </select>
                                    </label>
                                  }
                                }
                              </div>
                            }
                            @if (store.filesIssue(src.id, '/fields'); as e) {
                              <div class="migration__issue">{{ e }}</div>
                            }
                          }
                        </fieldset>
                      } @empty {
                        <p class="migration__hint">{{ 'ui.admin.migration.filesKind.none' | t }}</p>
                      }
                    </div>
                  </section>
                } @else if (store.openGroup(); as g) {
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
                        @for (src of store.linkable(); track src.id) {
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
                            @if (l.linked && g.key !== store.peopleGroup) {
                              <button type="button" class="migration__link migration__file-link" [attr.aria-expanded]="isOpen(src.id)" [attr.aria-controls]="'file-fields-' + src.id" (click)="toggleFile(src.id)">
                                {{ 'ui.admin.migration.group.moreOptions' | t }}
                              </button>
                            }
                          </label>
                          @if (l.linked && g.key === store.peopleGroup && !store.peopleReady(src.id)) {
                            <div class="migration__strip">
                              <span class="migration__hint">{{ 'ui.admin.migration.group.peopleNeeds' | t }}</span>
                            </div>
                          }
                          @if (l.linked && g.key !== store.peopleGroup) {
                            @let tg = store.targetIn(src.id);
                            @if (tg && isOpen(src.id)) {
                              <div class="migration__strip" [id]="'file-fields-' + src.id">
                                <label class="migration__field">
                                  <span>{{ 'ui.admin.migration.oldId' | t }}</span>
                                  <select (change)="store.setOldId(src.id, $any($event.target).value)">
                                    @for (col of src.columns; track col.name) {
                                      <option [value]="col.name" [selected]="col.name === tg.oldId">{{ col.name }}</option>
                                    }
                                  </select>
                                  @if (store.issueIn(src.id, '/oldId'); as e) {
                                    <span class="migration__issue">{{ e }}</span>
                                  }
                                </label>
                                <label class="migration__check" [title]="'ui.admin.migration.requiredHint' | t">
                                  <input type="checkbox" [checked]="tg.required" (change)="store.setRequired(src.id, $any($event.target).checked)" /> {{ 'ui.admin.migration.required' | t }}
                                </label>
                                @if (!store.filled(tg).count) {
                                  <span class="migration__hint">{{ 'ui.admin.migration.group.noFields' | t }}</span>
                                }
                              </div>
                              <div class="migration__strip">
                                <label class="migration__field">
                                  <span>{{ 'ui.admin.migration.dates.createdAt' | t }}</span>
                                  <select (change)="store.setDate(src.id, 'createdAt', $any($event.target).value)">
                                    <option value="" [selected]="!tg.dates?.createdAt">{{ 'ui.admin.migration.dates.none' | t }}</option>
                                    @for (col of src.columns; track col.name) {
                                      <option [value]="col.name" [selected]="col.name === tg.dates?.createdAt">{{ col.name }}</option>
                                    }
                                  </select>
                                  @if (store.issueIn(src.id, '/dates/createdAt'); as e) {
                                    <span class="migration__issue">{{ e }}</span>
                                  }
                                </label>
                                <label class="migration__field">
                                  <span>{{ 'ui.admin.migration.dates.updatedAt' | t }}</span>
                                  <select (change)="store.setDate(src.id, 'updatedAt', $any($event.target).value)">
                                    <option value="" [selected]="!tg.dates?.updatedAt">{{ 'ui.admin.migration.dates.none' | t }}</option>
                                    @for (col of src.columns; track col.name) {
                                      <option [value]="col.name" [selected]="col.name === tg.dates?.updatedAt">{{ col.name }}</option>
                                    }
                                  </select>
                                  @if (store.issueIn(src.id, '/dates/updatedAt'); as e) {
                                    <span class="migration__issue">{{ e }}</span>
                                  }
                                </label>
                                <span class="migration__hint">{{ 'ui.admin.migration.dates.hint' | t }}</span>
                              </div>
                              @if (store.stateAllowed() && store.openStates().length) {
                                <div class="migration__strip">
                                  <label class="migration__field">
                                    <span>{{ 'ui.admin.migration.state.column' | t }}</span>
                                    <select (change)="store.setStateColumn(src.id, $any($event.target).value)">
                                      <option value="" [selected]="!tg.state">{{ 'ui.admin.migration.dates.none' | t }}</option>
                                      @for (col of src.columns; track col.name) {
                                        <option [value]="col.name" [selected]="col.name === tg.state?.column">{{ col.name }}</option>
                                      }
                                    </select>
                                    @if (store.issueIn(src.id, '/state/column'); as e) {
                                      <span class="migration__issue">{{ e }}</span>
                                    }
                                  </label>
                                  <span class="migration__hint">{{ 'ui.admin.migration.state.hint' | t }}</span>
                                </div>
                                @if (tg.state) {
                                  <div class="migration__strip">
                                    @for (row of store.stateRows(src.id); track row.value) {
                                      <label class="migration__field">
                                        <span>{{ row.value }}</span>
                                        <select (change)="store.setStateValue(src.id, row.value, $any($event.target).value)">
                                          <option value="" [selected]="!row.state">{{ 'ui.admin.migration.state.choose' | t }}</option>
                                          @for (s of store.openStates(); track s.key) {
                                            <option [value]="s.key" [selected]="s.key === row.state">{{ s.label }}</option>
                                          }
                                        </select>
                                      </label>
                                    }
                                    <label class="migration__field">
                                      <span>{{ 'ui.admin.migration.state.addValue' | t }}</span>
                                      <input type="text" #typedValue />
                                    </label>
                                    <button appBtn size="sm" type="button" (click)="store.addStateValue(src.id, typedValue.value); typedValue.value = ''">{{ 'ui.admin.migration.state.add' | t }}</button>
                                    @if (store.issueIn(src.id, '/state/map'); as e) {
                                      <span class="migration__issue">{{ e }}</span>
                                    }
                                  </div>
                                }
                              }
                            }
                          }
                        }
                      </fieldset>
                      @if (g.key !== store.peopleGroup && g.files.length) {
                        <h3 class="migration__section">{{ 'ui.admin.migration.group.coverage' | t }}</h3>
                        <table class="migration__coverage migration__map">
                          <thead>
                            <tr>
                              <th scope="col">{{ 'ui.admin.migration.group.field' | t }}</th>
                              <th scope="col">{{ 'ui.admin.migration.group.file' | t }}</th>
                              <th scope="col">{{ 'ui.admin.migration.group.column' | t }}</th>
                              <th scope="col">{{ 'ui.admin.migration.transform.column' | t }}</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (r of store.fieldRows(); track r.field.key) {
                              <tr>
                                <th scope="row">{{ r.field.label }}@if (r.field.required) {<span class="migration__req" aria-hidden="true"> *</span>}</th>
                                <td>
                                  <select [attr.aria-label]="r.field.label + ' · ' + ('ui.admin.migration.group.file' | t)" (change)="store.setRowFile(r, $any($event.target).value)">
                                    <option value="" [selected]="!r.sourceId">{{ 'ui.admin.migration.group.notFilled' | t }}</option>
                                    @for (l of store.linkedFiles(); track l.source.id) {
                                      <option [value]="l.source.id" [selected]="l.source.id === r.sourceId">{{ l.source.fileName }}</option>
                                    }
                                  </select>
                                  @if (!r.sourceId && r.field.required) {
                                    <div class="migration__issue">{{ 'ui.admin.migration.group.missingRequired' | t }}</div>
                                  }
                                </td>
                                <td>
                                  @if (r.sourceId; as sid) {
                                    @if (r.choice; as c) {
                                      <select [attr.aria-label]="r.field.label + ' · ' + ('ui.admin.migration.group.column' | t)" (change)="store.setRowColumn(r, $any($event.target).value)">
                                        <option value="" [selected]="!c.value && r.derived === null">{{ 'ui.admin.migration.notImported' | t }}</option>
                                        @if (r.canDerive) {
                                          <option [value]="store.combine" [selected]="r.derived !== null">{{ 'ui.admin.migration.derive.option' | t }}</option>
                                        }
                                        @if (c.reference) {
                                          @for (col of store.columnsOf(sid); track col.name) {
                                            <option [value]="'column:' + col.name" [selected]="c.value === 'column:' + col.name">{{ 'ui.admin.migration.byOldId' | t: { column: col.name } }}</option>
                                          }
                                          @for (e of store.earlier(sid, c.field); track e.key) {
                                            <option [value]="'target:' + e.key" [selected]="c.value === 'target:' + e.key">{{ 'ui.admin.migration.fromTarget' | t: { target: store.typeOf(e.type)?.label ?? e.key } }}</option>
                                          }
                                        } @else {
                                          @for (col of store.columnsOf(sid); track col.name) {
                                            <option [value]="col.name" [selected]="c.value === col.name">{{ store.columnLabel(col) }}</option>
                                          }
                                        }
                                      </select>
                                      @if (store.issueIn(sid, '/fields/' + c.field.key) || store.issueIn(sid, '/refs/' + c.field.key); as e) {
                                        <div class="migration__issue">{{ e }}</div>
                                      }
                                      @if (r.derived !== null) {
                                        <div class="migration__derive">
                                          <label class="migration__field">
                                            <span>{{ 'ui.admin.migration.derive.template' | t }}</span>
                                            <input type="text" [value]="r.derived" [placeholder]="templateExample" (input)="store.setTemplate(r, $any($event.target).value)" />
                                          </label>
                                          <div class="migration__files" role="group" [attr.aria-label]="'ui.admin.migration.derive.columns' | t">
                                            @for (col of store.columnsOf(sid); track col.name) {
                                              <button type="button" class="migration__chip" [class.migration__chip--on]="store.usesColumn(r, col.name)" (click)="store.addToTemplate(r, col.name)">{{ col.name }}</button>
                                            }
                                          </div>
                                          @if (store.preview(r); as p) {
                                            <div class="migration__hint">{{ 'ui.admin.migration.derive.preview' | t: { value: p } }}</div>
                                          } @else {
                                            <div class="migration__hint">{{ 'ui.admin.migration.derive.hint' | t }}</div>
                                          }
                                          @if (store.issueIn(sid, '/derived/' + c.field.key + '/template') || store.issueIn(sid, '/derived/' + c.field.key); as e) {
                                            <div class="migration__issue">{{ e }}</div>
                                          }
                                        </div>
                                      }
                                      @if (c.person) {
                                        <details class="migration__more" [open]="!!c.legacyColumn">
                                          <summary>{{ 'ui.admin.migration.group.moreOptions' | t }}</summary>
                                          <label class="migration__field">
                                            <span>{{ 'ui.admin.migration.personLegacy' | t: { field: c.field.label } }}</span>
                                            <select (change)="store.choosePerson(r, $any($event.target).value)">
                                              <option value="" [selected]="!c.legacyColumn">{{ 'ui.admin.migration.notImported' | t }}</option>
                                              @for (col of store.columnsOf(sid); track col.name) {
                                                <option [value]="col.name" [selected]="c.legacyColumn === col.name">{{ col.name }}</option>
                                              }
                                            </select>
                                            <span class="migration__hint">{{ 'ui.admin.migration.personLegacyHint' | t }}</span>
                                            @if (store.issueIn(sid, '/persons/' + c.field.key + '/column') || store.issueIn(sid, '/persons/' + c.field.key); as e) {
                                              <span class="migration__issue">{{ e }}</span>
                                            }
                                          </label>
                                          @if (c.legacyColumn) {
                                            <label class="migration__field">
                                              <span>{{ 'ui.admin.migration.personOnMissing' | t }}</span>
                                              <select (change)="store.setOnMissing(r, $any($event.target).value)">
                                                <option value="blank" [selected]="c.onMissing === 'blank'">{{ 'ui.admin.migration.personBlank' | t }}</option>
                                                <option value="fail" [selected]="c.onMissing === 'fail'">{{ 'ui.admin.migration.personFail' | t }}</option>
                                              </select>
                                              @if (store.issueIn(sid, '/persons/' + c.field.key + '/onMissing'); as e) {
                                                <span class="migration__issue">{{ e }}</span>
                                              }
                                            </label>
                                          }
                                        </details>
                                      }
                                    } @else if (r.file; as fc) {
                                      <select [attr.aria-label]="r.field.label + ' · ' + ('ui.admin.migration.group.column' | t)" [attr.aria-required]="fc.field.required" (change)="store.setRowColumn(r, $any($event.target).value)">
                                        <option value="" [selected]="!fc.column">{{ 'ui.admin.migration.notImported' | t }}</option>
                                        @for (col of store.columnsOf(sid); track col.name) {
                                          <option [value]="col.name" [selected]="fc.column === col.name">{{ store.columnLabel(col) }}</option>
                                        }
                                      </select>
                                      <div class="migration__hint">{{ 'ui.admin.migration.file.columnHint' | t }}</div>
                                      @if (store.issueIn(sid, '/files/' + fc.field.key + '/column') || store.issueIn(sid, '/files/' + fc.field.key); as e) {
                                        <div class="migration__issue">{{ e }}</div>
                                      }
                                      @if (fc.column) {
                                        <details class="migration__more">
                                          <summary>{{ 'ui.admin.migration.group.moreOptions' | t }}</summary>
                                          <label class="migration__field">
                                            <span>{{ 'ui.admin.migration.file.onMissing' | t }}</span>
                                            <select (change)="store.setFileOption(r, 'onMissing', $any($event.target).value)">
                                              <option value="fail" [selected]="fc.onMissing === 'fail'">{{ 'ui.admin.migration.file.fail' | t }}</option>
                                              <option value="skip" [selected]="fc.onMissing === 'skip'">{{ 'ui.admin.migration.file.skip' | t }}</option>
                                            </select>
                                          </label>
                                          @if (fc.field.multiple) {
                                            <label class="migration__field">
                                              <span>{{ 'ui.admin.migration.file.separator' | t }}</span>
                                              <select (change)="store.setFileOption(r, 'separator', $any($event.target).value)">
                                                <option value=";" [selected]="fc.separator === ';'">{{ 'ui.admin.migration.separator.semicolon' | t }}</option>
                                                <option value="," [selected]="fc.separator === ','">{{ 'ui.admin.migration.separator.comma' | t }}</option>
                                              </select>
                                            </label>
                                          }
                                        </details>
                                      }
                                    }
                                  } @else {
                                    <span class="muted">—</span>
                                  }
                                </td>
                                <td>
                                  @if (r.canTransform) {
                                    <button type="button" class="migration__link" [attr.aria-expanded]="store.openRules() === r.field.key" (click)="store.toggleRules(r)">
                                      {{ 'ui.admin.migration.transform.link' | t }}@if (r.rules.length) { ({{ r.rules.length }}) }
                                    </button>
                                  }
                                </td>
                              </tr>
                              @if (r.canTransform && store.openRules() === r.field.key) {
                                <tr class="migration__rules-row">
                                  <td colspan="4">
                                    <div class="migration__rules" role="group" [attr.aria-label]="'ui.admin.migration.transform.title' | t: { field: r.field.label }">
                                      <strong>{{ 'ui.admin.migration.transform.title' | t: { field: r.field.label } }}</strong>
                                      <p class="migration__hint">{{ 'ui.admin.migration.transform.hint' | t }}</p>
                                      <table class="migration__coverage">
                                        <thead>
                                          <tr>
                                            <th scope="col">{{ 'ui.admin.migration.transform.from' | t }}</th>
                                            <th scope="col">{{ 'ui.admin.migration.transform.to' | t }}</th>
                                            <th scope="col" [attr.aria-label]="'ui.admin.migration.remove' | t"></th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          @for (rule of r.rules; track $index; let n = $index) {
                                            <tr>
                                              <td><input type="text" [value]="rule.from" [attr.aria-label]="'ui.admin.migration.transform.from' | t" (input)="store.setRule(r, n, 'from', $any($event.target).value)" /></td>
                                              <td>
                                                @if (r.field.type === 'choice' && r.field.choices?.length) {
                                                  <select [attr.aria-label]="'ui.admin.migration.transform.to' | t" (change)="store.setRule(r, n, 'to', $any($event.target).value)">
                                                    <option value="" [selected]="!rule.to">{{ 'ui.admin.migration.transform.blank' | t }}</option>
                                                    @for (ch of r.field.choices; track ch.value) {
                                                      <option [value]="ch.value" [selected]="rule.to === ch.value">{{ ch.label }}</option>
                                                    }
                                                  </select>
                                                } @else if (r.field.type === 'boolean') {
                                                  <select [attr.aria-label]="'ui.admin.migration.transform.to' | t" (change)="store.setRule(r, n, 'to', $any($event.target).value)">
                                                    <option value="" [selected]="!rule.to">{{ 'ui.admin.migration.transform.blank' | t }}</option>
                                                    <option value="yes" [selected]="rule.to === 'yes'">{{ 'ui.admin.migration.transform.yes' | t }}</option>
                                                    <option value="no" [selected]="rule.to === 'no'">{{ 'ui.admin.migration.transform.no' | t }}</option>
                                                  </select>
                                                } @else {
                                                  <input type="text" [value]="rule.to" [attr.aria-label]="'ui.admin.migration.transform.to' | t" (input)="store.setRule(r, n, 'to', $any($event.target).value)" />
                                                }
                                                @if (store.issueIn(r.sourceId, '/transforms/' + r.field.key + '/' + n + '/from') || store.issueIn(r.sourceId, '/transforms/' + r.field.key + '/' + n + '/to') || store.issueIn(r.sourceId, '/transforms/' + r.field.key + '/' + n); as e) {
                                                  <div class="migration__issue">{{ e }}</div>
                                                }
                                              </td>
                                              <td><button appBtn="danger" size="sm" type="button" class="migration__icon-btn" [attr.aria-label]="'ui.admin.migration.remove' | t" [title]="'ui.admin.migration.remove' | t" (click)="store.removeRule(r, n)"><app-icon name="delete" /></button></td>
                                            </tr>
                                          }
                                        </tbody>
                                      </table>
                                      <label class="migration__field">
                                        <span>{{ 'ui.admin.migration.transform.default' | t }}</span>
                                        @if (r.field.type === 'choice' && r.field.choices?.length) {
                                          <select [attr.aria-label]="'ui.admin.migration.transform.default' | t" (change)="store.setDefault(r, $any($event.target).value)">
                                            <option value="" [selected]="!r.default">{{ 'ui.admin.migration.transform.noDefault' | t }}</option>
                                            @for (ch of r.field.choices; track ch.value) {
                                              <option [value]="ch.value" [selected]="r.default === ch.value">{{ ch.label }}</option>
                                            }
                                          </select>
                                        } @else if (r.field.type === 'boolean') {
                                          <select [attr.aria-label]="'ui.admin.migration.transform.default' | t" (change)="store.setDefault(r, $any($event.target).value)">
                                            <option value="" [selected]="!r.default">{{ 'ui.admin.migration.transform.noDefault' | t }}</option>
                                            <option value="yes" [selected]="r.default === 'yes'">{{ 'ui.admin.migration.transform.yes' | t }}</option>
                                            <option value="no" [selected]="r.default === 'no'">{{ 'ui.admin.migration.transform.no' | t }}</option>
                                          </select>
                                        } @else {
                                          <input type="text" [value]="r.default" [attr.aria-label]="'ui.admin.migration.transform.default' | t" (input)="store.setDefault(r, $any($event.target).value)" />
                                        }
                                        <span class="migration__hint">{{ 'ui.admin.migration.transform.defaultHint' | t }}</span>
                                        @if (store.issueIn(r.sourceId, '/defaults/' + r.field.key); as e) {
                                          <span class="migration__issue">{{ e }}</span>
                                        }
                                      </label>
                                      @if (store.issueIn(r.sourceId, '/transforms/' + r.field.key); as e) {
                                        <div class="migration__issue">{{ e }}</div>
                                      }
                                      <div class="migration__actions">
                                        <button appBtn size="sm" type="button" class="migration__btn-icon" (click)="store.addRule(r)"><app-icon name="add" />{{ 'ui.admin.migration.transform.add' | t }}</button>
                                        @if (store.sampleValues(r).length) {
                                          <button appBtn size="sm" type="button" (click)="store.addSampleRules(r)">{{ 'ui.admin.migration.transform.addSamples' | t: { count: store.sampleValues(r).length } }}</button>
                                        }
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              }
                            }
                          </tbody>
                        </table>
                      } @else if (g.key !== store.peopleGroup) {
                        <p class="migration__hint">{{ 'ui.admin.migration.group.empty' | t }}</p>
                      }
                      @if (g.key === store.peopleGroup && store.peopleFiles().length) {
                        <h3 class="migration__section">{{ 'ui.admin.migration.group.coverage' | t }}</h3>
                        @if (store.rolesFailed()) {
                          <div class="notice warn" role="status">{{ 'ui.admin.migration.rolesUnavailable' | t }}</div>
                        }
                        <table class="migration__coverage migration__map">
                          <thead>
                            <tr>
                              <th scope="col">{{ 'ui.admin.migration.group.field' | t }}</th>
                              <th scope="col">{{ 'ui.admin.migration.group.file' | t }}</th>
                              <th scope="col">{{ 'ui.admin.migration.group.column' | t }}</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (r of store.peopleRows(); track r.key) {
                              @let d = store.drafts()[r.sourceId]?.people;
                              <tr>
                                <th scope="row">
                                  {{ r.label | t }}@if (r.required) {<span class="migration__req" aria-hidden="true"> *</span>}
                                  <div class="migration__hint">{{ r.hint | t }}</div>
                                </th>
                                <td>
                                  <select [attr.aria-label]="(r.label | t) + ' · ' + ('ui.admin.migration.group.file' | t)" (change)="store.setPeopleRowFile(r, $any($event.target).value)">
                                    <option value="" [selected]="!r.sourceId">{{ 'ui.admin.migration.group.notFilled' | t }}</option>
                                    @for (f of store.peopleFileChoices(); track f.id) {
                                      <option [value]="f.id" [selected]="f.id === r.sourceId">{{ f.name }}</option>
                                    }
                                  </select>
                                  @if (!r.sourceId && r.required) {
                                    <div class="migration__issue">{{ 'ui.admin.migration.group.missingRequired' | t }}</div>
                                  }
                                </td>
                                <td>
                                  @if (r.sourceId) {
                                    <select [attr.aria-label]="(r.label | t) + ' · ' + ('ui.admin.migration.group.column' | t)" [attr.aria-required]="r.required" (change)="store.setPeopleRowColumn(r, $any($event.target).value)">
                                      <option value="" [selected]="!r.column">{{ (r.required ? 'ui.admin.migration.chooseColumn' : 'ui.admin.migration.notInFile') | t }}</option>
                                      @for (col of store.columnsOf(r.sourceId); track col.name) {
                                        <option [value]="col.name" [selected]="r.column === col.name">{{ store.columnLabel(col) }}</option>
                                      }
                                    </select>
                                  }                                  @if (store.issue('/people/' + r.key) || store.issue('/people/' + r.draftKey); as e) {
                                    <div class="migration__issue">{{ e }}</div>
                                  }
                                  @if (r.key === 'status' && r.column && d) {
                                    <details class="migration__more">
                                      <summary>{{ 'ui.admin.migration.group.moreOptions' | t }}</summary>
                                      <label class="migration__field">
                                        <span>{{ 'ui.admin.migration.peopleActive' | t }}</span>
                                        <input type="text" [value]="d?.active" (input)="store.setPeople(r.sourceId, 'active', $any($event.target).value)" />
                                        <span class="migration__hint">{{ 'ui.admin.migration.peopleValuesHint' | t }}</span>
                                        @if (store.issue('/people/status/active'); as e) {
                                          <span class="migration__issue">{{ e }}</span>
                                        }
                                      </label>
                                      <label class="migration__field">
                                        <span>{{ 'ui.admin.migration.peopleSuspended' | t }}</span>
                                        <input type="text" [value]="d?.suspended" (input)="store.setPeople(r.sourceId, 'suspended', $any($event.target).value)" />
                                        <span class="migration__hint">{{ 'ui.admin.migration.peopleValuesHint' | t }}</span>
                                        @if (store.issue('/people/status/suspended'); as e) {
                                          <span class="migration__issue">{{ e }}</span>
                                        }
                                      </label>
                                    </details>
                                  }
                                  @if (r.key === 'roles' && r.column && d) {
                                    <details class="migration__more" open>
                                      <summary>{{ 'ui.admin.migration.group.moreOptions' | t }}</summary>
                                      <label class="migration__field">
                                        <span>{{ 'ui.admin.migration.peopleSeparator' | t }}</span>
                                        <select (change)="store.setPeople(r.sourceId, 'separator', $any($event.target).value)">
                                          @for (sep of separators; track sep.value) {
                                            <option [value]="sep.value" [selected]="d?.separator === sep.value">{{ 'ui.admin.migration.separator.' + sep.key | t }}</option>
                                          }
                                        </select>
                                        @if (store.issue('/people/roles/separator'); as e) {
                                          <span class="migration__issue">{{ e }}</span>
                                        }
                                      </label>
                                      <div class="migration__roles" role="group" [attr.aria-label]="'ui.admin.migration.roleMapTitle' | t">
                                        <div class="migration__roles-head"><span>{{ 'ui.admin.migration.roleMapTitle' | t }}</span><span>{{ 'ui.admin.migration.roleBecomes' | t }}</span></div>
                                        @for (rr of store.roleTable(r.sourceId); track rr.value) {
                                          <div class="migration__role">
                                            <b>{{ rr.value }}</b>
                                            <select [attr.aria-label]="'ui.admin.migration.roleFor' | t: { value: rr.value }" (change)="store.setRole(r.sourceId, rr.value, $any($event.target).value)">
                                              <option value="" [selected]="!rr.role">{{ 'ui.admin.migration.roleIgnore' | t }}</option>
                                              @for (role of store.roles(); track role.key) {
                                                <option [value]="role.key" [selected]="rr.role === role.key" [disabled]="!!role.requireTwoStep && rr.role !== role.key">{{ (role.requireTwoStep ? 'ui.admin.migration.roleTwoStepOption' : 'ui.admin.migration.roleOption') | t: { role: role.label } }}</option>
                                              }
                                            </select>
                                            @if (rr.role && store.twoStep(rr.role)) {
                                              <span class="migration__issue">{{ 'ui.admin.migration.roleTwoStep' | t: { role: store.roleLabel(rr.role) } }}</span>
                                            }
                                            @if (store.issue('/people/roles/map/' + rr.value); as e) {
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
                                          <input type="text" [value]="store.addedRoleValue()" (input)="store.addedRoleValue.set($any($event.target).value)" (keydown.enter)="$event.preventDefault(); store.addRoleValue(r.sourceId)" />
                                        </label>
                                        <button appBtn size="sm" type="button" [disabled]="!store.addedRoleValue().trim()" (click)="store.addRoleValue(r.sourceId)">{{ 'ui.admin.migration.roleAdd' | t }}</button>
                                      </div>
                                    </details>
                                  }
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      } @else if (g.key === store.peopleGroup) {
                        <p class="migration__hint">{{ 'ui.admin.migration.group.empty' | t }}</p>
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
                    @if (store.hasPeople(src.mapping)) {
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
                  @for (x of c.sources; track x.sourceId + (x.kind ?? '')) {
                    <li class="admin__row">
                      <span class="migration__icon" [attr.data-status]="x.invalid ? 'problems' : 'ready'"><app-icon name="file" /></span>
                      <span class="admin__label">
                        <strong>{{ x.fileName }}@if (x.kind) { · {{ (x.kind === 'people' ? 'ui.admin.migration.kindPeople' : 'ui.admin.migration.checkPart.records') | t }}}</strong>
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
  /** The placeholder of a template's input. */
  readonly templateExample = '{First name} {Last name}';
  /** A file is being dragged over the drop area. */
  readonly over = signal(false);
  /** Attachments are being dragged over their drop area. */
  readonly overFiles = signal(false);
  readonly separators = ROLE_SEPARATORS.map((value, i) => ({ value, key: ['semicolon', 'comma', 'bar'][i]! }));

  /** The files whose old-id, date and status settings are shown, by file id. */
  readonly openFiles = signal<ReadonlySet<string>>(new Set());

  isOpen(id: string): boolean {
    return this.openFiles().has(id);
  }

  toggleFile(id: string): void {
    this.openFiles.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

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

  /** The dropdown changed. When files are held the change waits for the dialog, so the select shows the kind still in force. */
  pickKind(select: HTMLSelectElement): void {
    this.store.requestKind(select.value as ImportKind);
    if (this.store.confirmKind()) select.value = this.store.importKind();
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
