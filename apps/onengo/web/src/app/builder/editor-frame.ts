import { NgComponentOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { PageFrame } from '@onengo/web-kit';
import { EDITOR_TABS, frameTab, type EditorTab } from '../core/builder/address';
import { summarySections } from '../core/builder/summary';
import { formatDate, t } from '../core/i18n/i18n';
import { DEFINITION_KINDS, type DefinitionKind } from '../core/models';
import type { RowView } from '../core/rows';
import { kindName } from '../core/starters';
import { TranslatePipe } from '../services/i18n';
import { ChipFilterBar } from '../ui/chip-bar';
import { MobileFormSheet } from '../ui/form-panel';
import { ListDetailSections } from '../ui/panel';
import { PageBack } from '../ui/page-back';
import { RowMenu } from '../ui/row-menu';
import { TableRows, type TableColumn } from '../ui/table-rows';
import { BuilderStore } from './builder-store';
import { visualEditor } from './editors';
import { JsonEditor } from './json-editor';

/**
 * The one frame every definition is edited in: title and state, the Visual,
 * JSON, Changes and History tabs, and the footer with the draft's state,
 * Discard, Check and Publish. Phones and people who may not publish get a
 * read-only summary instead.
 */
@Component({
  selector: 'app-editor-frame',
  imports: [NgComponentOutlet, TranslatePipe, ChipFilterBar, RowMenu, TableRows, MobileFormSheet, ListDetailSections, JsonEditor, PageBack, PageFrame],
  providers: [BuilderStore],
  styleUrl: './builder.css',
  template: `
    <app-page-frame>
      @let s = store.state();
      @if (!knownKind()) {
        <div class="notice error">{{ 'ui.builder.loadOneFailed' | t }}</div>
      } @else if (s?.missing) {
        <div class="notice info">
          {{ 'ui.builder.missing' | t }}
          <button type="button" class="small" (click)="store.backToCatalogue()">{{ 'ui.builder.backToCatalogue' | t }}</button>
        </div>
      } @else if (s && !s.loading && s.detail) {
        <header class="builder-head">
          <app-page-back />
          <div class="builder-head__title">
            <h1>{{ store.title() }}</h1>
            <span class="badge">{{ kindLabel() }}</span>
            @if (s.detail.published; as p) { <span class="badge ok">{{ 'ui.builder.publishedVersion' | t: { version: p.version } }}</span> }
            @if (s.detail.draft; as d) { <span class="badge warn">{{ 'ui.builder.draftVersion' | t: { version: d.version } }}</span> }
            @if (s.shipped && s.hasDraft) { <span class="badge warn">{{ 'ui.builder.draftOnDevice' | t }}</span> }
            @if (s.shipped) {
              <span class="badge">{{ (s.patched ? 'ui.builder.catalogue.modulePatched' : 'ui.builder.catalogue.module') | t }}</span>
            } @else {
              <span class="badge">{{ 'ui.builder.catalogue.fromOrganisation' | t }}</span>
            }
          </div>
          <span class="builder-spacer"></span>
          <app-row-menu look="table" [actions]="menu()" (choose)="menuAction($event)" />
        </header>

        @if (s.message) { <div class="notice ok" role="status">{{ s.message }}</div> }
        @if (s.error) {
          <div class="notice error" role="alert">
            {{ s.error }}
            @if (s.saveIssues.length) { <ul>@for (i of s.saveIssues; track $index) { <li><code>{{ i.path }}</code> {{ i.message }}</li> }</ul> }
          </div>
        }

        @if (!store.canEdit()) {
          <div class="notice info">{{ (store.narrow() ? 'ui.builder.phoneReadOnly' : 'ui.builder.viewOnly') | t }}</div>
          <app-list-detail-sections [sections]="summary()" />
        } @else {
          @if (s.shipped) { <div class="notice info">{{ 'ui.builder.shippedNotice' | t: { version: s.detail.shipped!.baseVersion } }}</div> }
          <app-chip-filter-bar [chips]="tabs()" [activeId]="tab()" (chipSelect)="selectTab($event)" />

          @if (s.check; as c) {
            @if (c.errors.length || c.warnings.length) {
              <div class="notice" [class.error]="c.errors.length" [class.info]="!c.errors.length" role="status">
                <strong>{{ 'ui.builder.checkResult' | t: { errors: c.errors.length, warnings: c.warnings.length } }}</strong>
                <ul>
                  @for (i of c.errors; track $index) { <li><code>{{ i.path }}</code> {{ i.message }}</li> }
                  @for (i of c.warnings; track $index) { <li>⚠ <code>{{ i.path }}</code> {{ i.message }}</li> }
                </ul>
              </div>
            } @else {
              <div class="notice ok" role="status">{{ 'ui.builder.checkOk' | t }}</div>
            }
          }

          <section class="builder-body" (focusout)="store.flush()">
            @switch (tab()) {
              @case ('visual') {
                @if (editor(); as e) {
                  <ng-container *ngComponentOutlet="e" />
                }
              }
              @case ('json') {
                <app-json-editor [body]="s.body" (bodyChange)="store.edit($event)" />
              }
              @case ('changes') {
                @if (s.shipped) {
                  <app-chip-filter-bar [chips]="changeChips()" [activeId]="s.changesAgainst" (chipSelect)="store.showChanges($any($event))" />
                }
                @if (s.changesLoading) {
                  <p class="muted">{{ 'ui.common.loading' | t }}</p>
                } @else if (s.changes; as ch) {
                  @if (ch.lines.length) {
                    <ul class="builder-lines">@for (line of ch.lines; track $index) { <li>{{ line }}</li> }</ul>
                  } @else {
                    <p class="muted">{{ (s.changesAgainst === 'module' ? 'ui.builder.changes.sameAsModule' : 'ui.builder.changes.none') | t }}</p>
                  }
                  @for (w of ch.warnings; track $index) { <div class="notice info">⚠ {{ w.message }}</div> }
                }
              }
              @case ('history') {
                @if (historyRows().length) {
                  <app-table-rows [rows]="historyRows()" [columns]="historyColumns()" badgeKey="status" (rowAction)="restore($event.row.id)" />
                } @else {
                  <p class="muted">{{ 'ui.builder.historyEmpty' | t }}</p>
                }
              }
            }
          </section>

          <footer class="builder-foot">
            <span class="muted">{{ saveText() }}</span>
            @if (s.check; as c) {
              @if (c.errors.length) { <span class="badge warn">{{ 'ui.builder.errorCount' | t: { count: c.errors.length } }}</span> }
              @if (c.warnings.length) { <span class="badge">{{ 'ui.builder.warningCount' | t: { count: c.warnings.length } }}</span> }
            }
            <span class="builder-spacer"></span>
            <button type="button" (click)="discard()" [disabled]="s.busy || !s.hasDraft">{{ 'ui.builder.discardDraft' | t }}</button>
            <button type="button" (click)="store.check()" [disabled]="s.busy || s.checking">{{ (s.checking ? 'ui.builder.checking' : 'ui.builder.check') | t }}</button>
            <button type="button" class="primary" (click)="store.openPublish()" [disabled]="s.busy || !canPublishNow()">{{ 'ui.builder.publishEllipsis' | t }}</button>
          </footer>

          <app-mobile-form-sheet
            [open]="!!s.summary"
            [title]="'ui.builder.publishTitle' | t: { name: store.title(), version: s.summary?.version ?? '' }"
            [saving]="s.busy"
            [saveLabel]="'ui.builder.publish' | t"
            [cancelLabel]="'ui.common.back' | t"
            [showDefaultFooter]="!s.summary?.errors?.length"
            (dismissed)="store.closePublish()"
            (save)="store.publish()">
            @if (s.summary; as sum) {
              <h3>{{ 'ui.builder.whatChanges' | t }}</h3>
              @if (sum.lines.length) {
                <ul class="builder-lines">@for (line of sum.lines; track $index) { <li>{{ line }}</li> }</ul>
              } @else {
                <p class="muted">{{ 'ui.builder.changes.none' | t }}</p>
              }
              @for (w of sum.warnings; track $index) { <div class="notice info">⚠ {{ w.message }}</div> }
              @if (sum.errors.length) {
                <div class="notice error" role="alert">
                  <strong>{{ 'ui.builder.fixFirst' | t }}</strong>
                  <ul>@for (i of sum.errors; track $index) { <li><code>{{ i.path }}</code> {{ i.message }}</li> }</ul>
                </div>
              }
            }
            @if (s.summary?.errors?.length) {
              <button sheetFooterActions type="button" (click)="store.closePublish()">{{ 'ui.common.back' | t }}</button>
            }
          </app-mobile-form-sheet>
        }
      } @else if (s?.error) {
        <div class="notice error" role="alert">{{ s?.error }}</div>
      } @else {
        <p class="muted">{{ 'ui.common.loading' | t }}</p>
      }
    </app-page-frame>
  `,
})
export class EditorFrame {
  readonly store = inject(BuilderStore);
  readonly kind = input.required<string>();
  readonly key = input.required<string>();

  readonly knownKind = computed(() => (DEFINITION_KINDS as readonly string[]).includes(this.kind()));
  readonly kindLabel = computed(() => (this.knownKind() ? kindName(this.kind() as DefinitionKind) : ''));
  readonly editor = computed(() => (this.knownKind() ? visualEditor(this.kind() as DefinitionKind) : null));
  readonly tabs = computed(() => EDITOR_TABS.map((id) => ({ id, label: t(`ui.builder.tabs.${id}`) })));
  readonly tab = computed(() => frameTab(this.store.address().tab));
  readonly changeChips = computed(() => [
    { id: 'published', label: t('ui.builder.changes.draftVsPublished') },
    { id: 'module', label: t('ui.builder.changes.organisationVsModule') },
  ]);
  readonly historyColumns = computed<TableColumn[]>(() => [
    { key: 'version', label: t('ui.builder.version') },
    { key: 'status', label: t('ui.builder.status') },
    { key: 'publishedAt', label: t('ui.builder.published') },
  ]);
  readonly historyRows = computed<RowView[]>(() => {
    const s = this.store.state();
    const canRestore = this.store.canPublish();
    return (s?.history ?? []).map((h) => {
      const status = t(`ui.builder.historyStatus.${h.status}`);
      const when = h.publishedAt ? formatDate(h.publishedAt) : '—';
      return {
        id: String(h.version),
        title: t('ui.common.version', { version: h.version }),
        badge: { label: status, tone: h.status === 'published' ? 'success' : h.status === 'draft' ? 'warning' : 'neutral' },
        cells: [
          { key: 'version', label: t('ui.builder.version'), value: t('ui.common.version', { version: h.version }) },
          { key: 'status', label: t('ui.builder.status'), value: status },
          { key: 'publishedAt', label: t('ui.builder.published'), value: when },
        ],
        actions: h.canRestore && canRestore ? [{ id: 'restore', label: t('ui.builder.restore') }] : [],
      };
    });
  });
  readonly menu = computed(() => {
    const s = this.store.state();
    const out = [{ id: 'catalogue', label: t('ui.builder.backToCatalogue') }];
    if (s && this.store.canPublish() && !this.store.narrow()) out.push({ id: 'duplicate', label: t('ui.builder.catalogue.duplicate') });
    if (s?.shipped && s.patched && this.store.canPublish()) out.push({ id: 'revert', label: t('ui.builder.revertToModule') });
    if (s?.hasDraft && this.store.canEdit()) out.push({ id: 'discard', label: t('ui.builder.discardDraft') });
    return out;
  });
  readonly summary = computed(() => {
    const s = this.store.state();
    return s ? summarySections(s.kind, s.key, s.detail, s.body) : [];
  });
  readonly canPublishNow = computed(() => {
    const s = this.store.state();
    return !!s && this.store.canPublish() && (s.hasDraft || s.save !== 'saved');
  });
  readonly saveText = computed(() => {
    const s = this.store.state();
    if (!s) return '';
    if (s.save === 'saving') return t('ui.builder.saving');
    if (s.save === 'pending') return t('ui.builder.unsaved');
    if (s.save === 'failed') return t('ui.builder.notSaved');
    if (!s.hasDraft) return t('ui.builder.noDraft');
    const time = this.store.savedTime();
    if (s.shipped) return time ? t('ui.builder.keptOnDeviceAt', { time }) : t('ui.builder.keptOnDevice');
    return time ? t('ui.builder.draftSavedAt', { time }) : t('ui.builder.draftSaved');
  });

  constructor() {
    effect(() => {
      const kind = this.kind();
      const key = this.key();
      untracked(() => {
        if (this.knownKind()) this.store.use(kind as DefinitionKind, key);
      });
    });
  }

  selectTab(id: string): void {
    this.store.selectTab(id as EditorTab);
  }

  menuAction(id: string): void {
    if (id === 'catalogue') this.store.backToCatalogue();
    else if (id === 'duplicate') this.store.duplicate();
    else if (id === 'revert') void this.revert();
    else if (id === 'discard') void this.discard();
  }

  async discard(): Promise<void> {
    if (confirm(t('ui.builder.confirmDiscard'))) await this.store.discard();
  }

  async revert(): Promise<void> {
    if (confirm(t('ui.builder.confirmRevert'))) await this.store.revert();
  }

  async restore(version: string): Promise<void> {
    if (confirm(t('ui.builder.confirmRestore', { version }))) await this.store.restore(Number(version));
  }
}
