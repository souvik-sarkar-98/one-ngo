import { Component, computed, effect, inject, signal, untracked, afterRenderEffect } from '@angular/core';
import { Icon, opensInPlace, PageFrame } from '@onengo/web-kit';
import { RECORD_TYPE_STARTERS, builderHome, homeRowReadOnly, kindPageCopy, needsRecordType, starterName, type BuilderHomeRow, type CatalogueAction } from '../core/builder/catalogue';
import { toKey } from '../core/fields/fields';
import { t } from '../core/i18n/i18n';
import type { RowView } from '../core/rows';
import { TranslatePipe } from '../services/i18n';
import { Session } from '../services/session';
import { InfiniteListRow } from '../ui/card-rows';
import { CreateButton } from '../ui/create-button';
import { MobileFormSheet } from '../ui/form-panel';
import { PageBack } from '../ui/page-back';
import { opensRow } from '../ui/row-keys';
import { TableRows, type TableColumn } from '../ui/table-rows';
import { CatalogueStore } from './catalogue-store';

/**
 * Builder home, in the same shape as Administration: a heading, the introduction,
 * and grouped rows. A kind opens its own list. Theme, layout, translations,
 * access and modules open their screens directly.
 */
@Component({
  selector: 'app-catalogue-screen',
  imports: [Icon, TranslatePipe, InfiniteListRow, TableRows, MobileFormSheet, PageBack, PageFrame, CreateButton],
  providers: [CatalogueStore],
  styleUrls: ['./builder.css', '../ui/styles/na-list-dashboard.css'],
  template: `
    <app-page-frame>
      @if (page(); as page) {
        <header class="builder-head">
          <button type="button" class="builder-back" [attr.aria-label]="'ui.common.back' | t" (click)="back()">
            <app-icon name="back" />
          </button>
          <h1>{{ page.titleKey | t }}</h1>
          <span class="builder-spacer"></span>
          @if (store.canPublish() && !store.narrow()) {
            <button type="button" class="app-btn app-btn--primary" (click)="startKind()">{{ page.createKey | t }}</button>
          }
        </header>
        <p class="muted">{{ page.hintKey | t }}</p>
        @if (store.showKindSearch()) {
          <div class="field">
            <label for="kind-search">{{ 'ui.common.search' | t }}</label>
            <input id="kind-search" type="search" [placeholder]="'ui.builder.catalogue.searchPlaceholder' | t" [value]="store.searchText()" (input)="store.search($any($event.target).value)" />
          </div>
        }
        @if (store.canPublish() && store.narrow()) {
          <div class="list-dashboard__floating-actions">
            <app-create-button [label]="page.createKey | t" (pressed)="startKind()" />
          </div>
        }
      } @else {
        <header class="builder-head">
          <app-page-back />
          <h1>{{ 'ui.builder.title' | t }}</h1>
        </header>
        <p class="muted">{{ 'ui.builder.intro' | t }}</p>
      }

      @if (store.error()) { <div class="notice error" role="alert">{{ store.error() }}</div> }

      @if (page()) {
        @if (store.loading()) {
          <p class="muted">{{ 'ui.common.loading' | t }}</p>
        } @else if (!store.rows().length) {
          <p class="muted">{{ 'ui.common.noItemsFound' | t }}</p>
        } @else if (store.narrow()) {
          <div class="builder-cards">
            @for (r of store.rows(); track r.id) {
              <div class="builder-card" role="button" tabindex="0" (click)="store.open(r)" (keydown)="key($event, r)">
                <app-infinite-list-row [item]="r" />
              </div>
            }
          </div>
        } @else {
          <div class="builder-panel">
            <app-table-rows
              [rows]="store.rows()"
              [columns]="columns()"
              [sort]="store.address().sort"
              badgeKey="state"
              (rowClick)="store.open($event)"
              (rowAction)="rowAction($event.row, $event.action)"
              (sortToggle)="store.toggleSort($event)" />
          </div>
        }
      } @else {
        @for (group of groups(); track group.id) {
          <h2 class="builder-caption" [id]="'builder-' + group.id">{{ group.labelKey | t }}</h2>
          <ul class="builder-dir" [attr.aria-labelledby]="'builder-' + group.id">
            @for (row of group.rows; track row.id) {
              <li>
                <a [href]="row.href" (click)="go($event, row.href)">
                  <span class="builder-dir__label">
                    <strong>{{ row.labelKey | t }}</strong>
                    <span class="muted">{{ row.hintKey | t }}</span>
                    @if (readOnly(row)) { <span class="badge">{{ 'ui.builder.home.readOnly' | t }}</span> }
                  </span>
                  <span aria-hidden="true">›</span>
                </a>
              </li>
            }
          </ul>
        }
      }

      <app-mobile-form-sheet
        [open]="!!store.creating()"
        [title]="newTitle()"
        [saving]="store.busy()"
        [saveLabel]="'ui.common.create' | t"
        (dismissed)="cancel()"
        (save)="store.create(name(), recordType())">
        <div class="field">
          <label for="new-name">{{ 'ui.builder.name' | t }}</label>
          <input id="new-name" [placeholder]="'ui.builder.namePlaceholder' | t" [value]="name()" (input)="name.set($any($event.target).value)" />
          @if (newKey()) { <div class="help">{{ 'ui.builder.keyHint' | t: { key: newKey() } }}</div> }
        </div>
        @if (showStarter()) {
          <div class="field">
            <label for="new-starter">{{ 'ui.builder.catalogue.readyMade' | t }}</label>
            <select id="new-starter" [value]="store.creating()?.starter ?? ''" (change)="pickStarter($any($event.target).value)">
              <option value="">{{ 'ui.builder.catalogue.readyMadeNone' | t }}</option>
              @for (starter of starters; track starter.id) { <option [value]="starter.id">{{ starterLabel(starter.id) }}</option> }
            </select>
          </div>
        }
        @if (askRecordType()) {
          <div class="field">
            <label for="new-record-type">{{ 'ui.builder.workflow.recordType' | t }}</label>
            <select id="new-record-type" [value]="recordType()" (change)="recordType.set($any($event.target).value)">
              <option value=""></option>
              @for (r of store.recordTypes(); track r.key) { <option [value]="r.key">{{ r.label || r.key }}</option> }
            </select>
          </div>
        }
        @if (store.createError()) { <div class="error" role="alert">{{ store.createError() }}</div> }
      </app-mobile-form-sheet>
    </app-page-frame>
  `,
})
export class CatalogueScreen {
  readonly store = inject(CatalogueStore);
  private readonly session = inject(Session);
  readonly starters = RECORD_TYPE_STARTERS;
  readonly name = signal('');
  readonly recordType = signal('');
  readonly newKey = computed(() => toKey(this.name()));
  readonly columns = computed<TableColumn[]>(() => [
    { key: 'label', label: t('ui.builder.name'), sortable: true },
    { key: 'kind', label: t('ui.builder.kindLabel'), sortable: true },
    { key: 'key', label: t('ui.builder.key'), sortable: true },
    { key: 'from', label: t('ui.builder.catalogue.from') },
    { key: 'state', label: t('ui.builder.catalogue.state'), sortable: true },
  ]);
  readonly page = computed(() => {
    const kind = this.store.address().kind;
    return kind ? kindPageCopy(kind) : null;
  });
  readonly askRecordType = computed(() => {
    const creating = this.store.creating();
    return !!creating && !creating.copyOf && needsRecordType(creating.kind);
  });
  readonly showStarter = computed(() => {
    const creating = this.store.creating();
    return !!creating && creating.kind === 'recordType' && !creating.copyOf;
  });
  readonly newTitle = computed(() => {
    const creating = this.store.creating();
    if (!creating) return '';
    if (creating.copyOf) return t('ui.builder.catalogue.duplicateTitle', { name: creating.copyOf.label || creating.copyOf.key });
    if (creating.starter) return t('ui.builder.catalogue.startFrom', { name: starterName(creating.starter) });
    return t('ui.builder.catalogue.newTitle', { kind: t(`ui.builder.kind.${creating.kind}`) });
  });

  constructor() {
    afterRenderEffect(() => {
      const section = this.store.section();
      const kind = this.store.address().kind;
      if (kind || section === 'all') return;
      document.getElementById(`builder-${section}`)?.scrollIntoView({ block: 'start' });
    });
    effect(() => {
      const copy = this.store.creating()?.copyOf;
      if (!copy) return;
      const label = t('ui.builder.catalogue.copyName', { name: copy.label || copy.key });
      untracked(() => this.name.set(label));
    });
  }

  groups() {
    return builderHome();
  }

  /** Scripts and Modules open for looking only without the permission that changes them. */
  readOnly(row: BuilderHomeRow): boolean {
    return homeRowReadOnly(row, this.session.me());
  }

  starterLabel(id: string): string {
    return starterName(id);
  }

  go(event: MouseEvent, href: string): void {
    if (!opensInPlace(event)) return;
    event.preventDefault();
    this.store.goTo(href);
  }

  back(): void {
    this.store.goTo('/builder');
  }

  rowAction(row: RowView, action: string): void {
    if (action === 'duplicate') {
      this.name.set(t('ui.builder.catalogue.copyName', { name: row.title }));
      this.recordType.set('');
    }
    if (action === 'revert' && !confirm(t('ui.builder.confirmRevert'))) return;
    if (action === 'deleteDraft' && !confirm(t('ui.builder.confirmDiscard'))) return;
    void this.store.runRowAction(row, action as CatalogueAction);
  }

  key(e: KeyboardEvent, row: RowView): void {
    if (!opensRow(e)) return;
    e.preventDefault();
    this.store.open(row);
  }

  startKind(): void {
    const kind = this.store.address().kind;
    if (!kind) return;
    this.name.set('');
    this.recordType.set('');
    this.store.startNew({ kind });
  }

  pickStarter(id: string): void {
    const current = this.store.creating();
    if (!current) return;
    const previous = current.starter ? starterName(current.starter) : '';
    this.store.creating.set({ ...current, starter: id || undefined });
    if (id && (this.name() === '' || this.name() === previous)) this.name.set(starterName(id));
  }

  cancel(): void {
    this.name.set('');
    this.recordType.set('');
    this.store.cancelNew();
  }
}
